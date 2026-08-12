/**
 * rep-analysis.js
 *
 * Pure math only — no DOM, no MediaPipe, no fetch. Takes a time series
 * of BlazePose landmarks (already produced by MediaPipe elsewhere)
 * and turns it into rep boundaries, depth, tempo, and left/right
 * asymmetry, then picks a small set of representative timestamps
 * worth turning into still frames for the LLM.
 *
 * Kept pure and dependency-free specifically so it can be unit tested
 * with synthetic knee-angle arrays under plain Node — see
 * test/rep-analysis.test.js — without needing a browser, a video
 * file, or MediaPipe's model files at all. This is the piece of
 * checkpoint 2 that self-testing can actually cover end-to-end; the
 * MediaPipe pose-detection call itself can only be exercised on a
 * real device (see DESIGN.md section 14 and app.js's comments near
 * runPoseAnalysis_).
 *
 * BlazePose 33-point indices used here: 23/24 = left/right hip,
 * 25/26 = left/right knee, 27/28 = left/right ankle. Standard
 * MediaPipe Pose topology — not re-derived from this session's
 * (network-blocked) verification of the API surface, so treat the
 * landmark layout itself as "expected, not independently confirmed
 * this session" the same way DESIGN.md already flags for other
 * pre-training-knowledge details.
 */

(function (root) {
  var LEFT_HIP = 23, RIGHT_HIP = 24, LEFT_KNEE = 25, RIGHT_KNEE = 26, LEFT_ANKLE = 27, RIGHT_ANKLE = 28;
  var VISIBILITY_MIN = 0.5;

  /** Angle at point b (degrees) formed by a-b-c, using 2D x/y only. */
  function angleAtPoint(a, b, c) {
    var abx = a.x - b.x, aby = a.y - b.y;
    var cbx = c.x - b.x, cby = c.y - b.y;
    var dot = abx * cbx + aby * cby;
    var magAb = Math.sqrt(abx * abx + aby * aby);
    var magCb = Math.sqrt(cbx * cbx + cby * cby);
    if (magAb === 0 || magCb === 0) return null;
    var cos = Math.max(-1, Math.min(1, dot / (magAb * magCb)));
    return (Math.acos(cos) * 180) / Math.PI;
  }

  function visible(landmark) {
    return !!landmark && (landmark.visibility === undefined || landmark.visibility >= VISIBILITY_MIN);
  }

  /**
   * frames: [{ t (ms), landmarks: NormalizedLandmark[33] }]
   * Returns [{ t, angle, leftAngle, rightAngle }] — angle is the
   * average of whichever side(s) are visible; leftAngle/rightAngle
   * are kept separately (null if that side wasn't visible) so
   * asymmetry can be computed later.
   */
  function computeKneeAngleSeries(frames) {
    return (frames || []).map(function (f) {
      var lm = f.landmarks || [];
      var leftAngle = null, rightAngle = null;
      if (visible(lm[LEFT_HIP]) && visible(lm[LEFT_KNEE]) && visible(lm[LEFT_ANKLE])) {
        leftAngle = angleAtPoint(lm[LEFT_HIP], lm[LEFT_KNEE], lm[LEFT_ANKLE]);
      }
      if (visible(lm[RIGHT_HIP]) && visible(lm[RIGHT_KNEE]) && visible(lm[RIGHT_ANKLE])) {
        rightAngle = angleAtPoint(lm[RIGHT_HIP], lm[RIGHT_KNEE], lm[RIGHT_ANKLE]);
      }
      var parts = [leftAngle, rightAngle].filter(function (a) { return a !== null; });
      var angle = parts.length ? parts.reduce(function (s, a) { return s + a; }, 0) / parts.length : null;
      return { t: f.t, angle: angle, leftAngle: leftAngle, rightAngle: rightAngle };
    });
  }

  /** Simple centered moving average over `angle`, ignoring nulls. Window is odd (e.g. 5). */
  function smoothSeries(series, window) {
    window = window || 5;
    var half = Math.floor(window / 2);
    return series.map(function (point, i) {
      var lo = Math.max(0, i - half), hi = Math.min(series.length - 1, i + half);
      var sum = 0, count = 0;
      for (var j = lo; j <= hi; j++) {
        if (series[j].angle !== null && series[j].angle !== undefined) { sum += series[j].angle; count++; }
      }
      return Object.assign({}, point, { angle: count ? sum / count : point.angle });
    });
  }

  function percentile(sortedValues, p) {
    if (!sortedValues.length) return null;
    var idx = Math.min(sortedValues.length - 1, Math.max(0, Math.round((p / 100) * (sortedValues.length - 1))));
    return sortedValues[idx];
  }

  /**
   * Segments a smoothed knee-angle series into reps.
   *
   * Algorithm: the "standing" baseline is estimated as the 85th
   * percentile of all angle readings (near-full-extension dominates
   * the time between reps for a squat-style movement). A rep is a
   * contiguous stretch where the angle drops at least `depthThresholdDeg`
   * below that baseline; each such stretch's minimum angle is the
   * bottom of that rep. Stretches shorter than `minRepDurationMs` are
   * treated as noise and dropped (e.g. a brief pose-tracking glitch
   * should not register as a rep).
   *
   * options: { depthThresholdDeg = 20, minRepDurationMs = 400 }
   * Returns { repCount, avgTempoSec, baselineAngleDeg, reps: [{ repIndex, startT, bottomT, endT,
   *   bottomAngleDeg, depthDeg, tempoSec, asymmetryScore }] }
   */
  function segmentReps(series, options) {
    options = options || {};
    var depthThresholdDeg = options.depthThresholdDeg !== undefined ? options.depthThresholdDeg : 20;
    var minRepDurationMs = options.minRepDurationMs !== undefined ? options.minRepDurationMs : 400;

    var valid = series.filter(function (p) { return typeof p.angle === 'number'; });
    if (valid.length < 3) {
      return { repCount: 0, avgTempoSec: null, baselineAngleDeg: null, reps: [] };
    }
    var sortedAngles = valid.map(function (p) { return p.angle; }).sort(function (a, b) { return a - b; });
    var baseline = percentile(sortedAngles, 85);
    var threshold = baseline - depthThresholdDeg;

    var reps = [];
    var inRep = false;
    var repStart = null;
    var repPoints = [];

    for (var i = 0; i < valid.length; i++) {
      var p = valid[i];
      var below = p.angle <= threshold;
      if (below && !inRep) {
        inRep = true;
        repStart = p.t;
        repPoints = [p];
      } else if (below && inRep) {
        repPoints.push(p);
      } else if (!below && inRep) {
        inRep = false;
        var repEnd = p.t;
        finalizeRep_(reps, repPoints, repStart, repEnd, minRepDurationMs, baseline);
      }
    }
    if (inRep && repPoints.length) {
      finalizeRep_(reps, repPoints, repStart, valid[valid.length - 1].t, minRepDurationMs, baseline);
    }

    reps.forEach(function (r, idx) { r.repIndex = idx + 1; });

    var tempos = reps.map(function (r) { return r.tempoSec; }).filter(function (t) { return t !== null; });
    var avgTempoSec = tempos.length ? Math.round((tempos.reduce(function (s, t) { return s + t; }, 0) / tempos.length) * 100) / 100 : null;

    return { repCount: reps.length, avgTempoSec: avgTempoSec, baselineAngleDeg: Math.round(baseline * 10) / 10, reps: reps };
  }

  function finalizeRep_(reps, repPoints, startT, endT, minRepDurationMs, baseline) {
    var durationMs = endT - startT;
    if (durationMs < minRepDurationMs) return; // treat as noise, not a rep
    var bottom = repPoints.reduce(function (min, p) { return (min === null || p.angle < min.angle) ? p : min; }, null);
    var asymmetryScore = null;
    if (typeof bottom.leftAngle === 'number' && typeof bottom.rightAngle === 'number') {
      asymmetryScore = Math.round(Math.abs(bottom.leftAngle - bottom.rightAngle) * 10) / 10;
    }
    reps.push({
      repIndex: 0, // filled in by caller after all reps are known
      startT: startT,
      bottomT: bottom.t,
      endT: endT,
      bottomAngleDeg: Math.round(bottom.angle * 10) / 10,
      depthDeg: Math.round((baseline - bottom.angle) * 10) / 10,
      tempoSec: Math.round((durationMs / 1000) * 100) / 100,
      asymmetryScore: asymmetryScore
    });
  }

  /**
   * Turns segmentReps()'s output into the repSummary shape Ai.gs's
   * FORM_REPORT_SCHEMA_ prompt expects (see buildFormCheckPrompt_ in
   * Ai.gs) — kept as a separate step so segmentReps() itself stays
   * generic/testable and this mapping can change independently.
   */
  function toRepSummary(segmentation) {
    return {
      repCount: segmentation.repCount,
      avgTempoSec: segmentation.avgTempoSec,
      reps: segmentation.reps.map(function (r) {
        return {
          repIndex: r.repIndex,
          kneeAngleDeg: r.bottomAngleDeg,
          tempoSec: r.tempoSec,
          asymmetryScore: r.asymmetryScore
        };
      })
    };
  }

  /**
   * Picks a small, deduplicated set of timestamps (ms) worth turning
   * into still frames: the overall start, the deepest rep's bottom
   * (best form example or worst depth issue), the shallowest rep's
   * bottom (partial-rep concern) if it's a different rep, the most
   * asymmetric rep's bottom if it's a different rep again, and the
   * overall finish. Capped at `maxFrames` (Ai.gs's handleAnalyzeForm_
   * rejects more than 8 frames per request).
   */
  function selectRepresentativeTimestamps(segmentation, videoDurationMs, maxFrames) {
    maxFrames = maxFrames || 6;
    var picks = [];
    var pushUnique = function (t, label) {
      if (t === null || t === undefined) return;
      if (picks.some(function (p) { return Math.abs(p.t - t) < 50; })) return; // dedupe near-identical timestamps
      picks.push({ t: t, label: label });
    };

    pushUnique(0, 'start');

    var reps = segmentation.reps || [];
    if (reps.length) {
      var deepest = reps.reduce(function (min, r) { return (min === null || r.bottomAngleDeg < min.bottomAngleDeg) ? r : min; }, null);
      pushUnique(deepest.bottomT, 'deepest');

      var shallowest = reps.reduce(function (max, r) { return (max === null || r.bottomAngleDeg > max.bottomAngleDeg) ? r : max; }, null);
      pushUnique(shallowest.bottomT, 'shallowest');

      var withAsymmetry = reps.filter(function (r) { return typeof r.asymmetryScore === 'number'; });
      if (withAsymmetry.length) {
        var mostAsymmetric = withAsymmetry.reduce(function (max, r) { return (max === null || r.asymmetryScore > max.asymmetryScore) ? r : max; }, null);
        pushUnique(mostAsymmetric.bottomT, 'most-asymmetric');
      }
    }

    if (typeof videoDurationMs === 'number' && videoDurationMs > 0) {
      pushUnique(Math.max(0, videoDurationMs - 100), 'finish');
    }

    return picks.slice(0, maxFrames);
  }

  var RepAnalysis = {
    computeKneeAngleSeries: computeKneeAngleSeries,
    smoothSeries: smoothSeries,
    segmentReps: segmentReps,
    toRepSummary: toRepSummary,
    selectRepresentativeTimestamps: selectRepresentativeTimestamps,
    // Exposed for tests only:
    _angleAtPoint: angleAtPoint
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RepAnalysis;
  } else {
    root.RepAnalysis = RepAnalysis;
  }
})(typeof window !== 'undefined' ? window : globalThis);
