import express from 'express';
import fetch from 'node-fetch';

const app = express();
const port = process.env.PORT || 3000;

// Biến lưu trữ dự đoán của các mô hình
const modelPredictions = {
  trend: {},
  short: {},
  mean: {},
  switch: {},
  bridge: {},
};

// --- HÀM XỬ LÝ DỮ LIỆU ---

function processResult(score) {
  if (score >= 4 && score <= 10) {
    return 'Xỉu';
  } else if (score >= 11 && score <= 17) {
    return 'Tài';
  } else {
    return 'Không xác định';
  }
}

async function fetchData() {
  const url = 'https://api.wsmt8g.cc/v2/history/getLastResult?gameId=ktrng_3932&size=120&tableId=39321215743193&curPage=1';
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Lỗi khi fetch dữ liệu:', error);
    return null;
  }
}

// --- THUẬT TOÁN DỰ ĐOÁN ---

function detectStreakAndBreak(history) {
  if (!history || history.length === 0) return { streak: 0, currentResult: null, breakProb: 0.0 };
  let streak = 1;
  const currentResult = history[history.length - 1].result;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].result === currentResult) {
      streak++;
    } else {
      break;
    }
  }
  const last15 = history.slice(-15).map(h => h.result);
  if (!last15.length) return { streak, currentResult, breakProb: 0.0 };
  const switches = last15.slice(1).reduce((count, curr, idx) => count + (curr !== last15[idx] ? 1 : 0), 0);
  const taiCount = last15.filter(r => r === 'Tài').length;
  const xiuCount = last15.filter(r => r === 'Xỉu').length;
  const imbalance = Math.abs(taiCount - xiuCount) / last15.length;
  let breakProb = 0.0;
  if (streak >= 6) {
    breakProb = Math.min(0.8 + (switches / 15) + imbalance * 0.3, 0.95);
  } else if (streak >= 4) {
    breakProb = Math.min(0.5 + (switches / 12) + imbalance * 0.25, 0.9);
  } else if (streak >= 2 && switches >= 5) {
    breakProb = 0.45;
  } else if (streak === 1 && switches >= 6) {
    breakProb = 0.3;
  }
  return { streak, currentResult, breakProb };
}

function evaluateModelPerformance(history, modelName, lookback = 10) {
  if (!modelPredictions[modelName] || history.length < 2) return 1.0;
  lookback = Math.min(lookback, history.length - 1);
  let correctCount = 0;
  for (let i = 0; i < lookback; i++) {
    const pred = modelPredictions[modelName][history[history.length - (i + 2)].session] || 0;
    const actual = history[history.length - (i + 1)].result;
    if ((pred === 1 && actual === 'Tài') || (pred === 2 && actual === 'Xỉu')) {
      correctCount++;
    }
  }
  const performanceScore = lookback > 0 ? 1.0 + (correctCount - lookback / 2) / (lookback / 2) : 1.0;
  return Math.max(0.0, Math.min(2.0, performanceScore));
}

function smartBridgeBreak(history) {
  if (!history || history.length < 5) return { prediction: 0, breakProb: 0.0, reason: 'Không đủ dữ liệu để theo/bẻ cầu' };
  const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
  const last20 = history.slice(-20).map(h => h.result);
  const lastScores = history.slice(-20).map(h => h.totalScore || 0);
  let breakProbability = breakProb;
  let reason = '';
  const avgScore = lastScores.reduce((sum, score) => sum + score, 0) / (lastScores.length || 1);
  const scoreDeviation = lastScores.reduce((sum, score) => sum + Math.abs(score - avgScore), 0) / (lastScores.length || 1);
  const last5 = last20.slice(-5);
  const patternCounts = {};
  for (let i = 0; i <= last20.length - 2; i++) {
    const pattern = last20.slice(i, i + 2).join(',');
    patternCounts[pattern] = (patternCounts[pattern] || 0) + 1;
  }
  const mostCommonPattern = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
  const isStablePattern = mostCommonPattern && mostCommonPattern[1] >= 3;
  if (streak >= 3 && scoreDeviation < 2.0 && !isStablePattern) {
    breakProbability = Math.max(breakProbability - 0.25, 0.1);
    reason = `[Theo Cầu Thông Minh] Chuỗi ${streak} ${currentResult} ổn định, tiếp tục theo cầu`;
  } else if (streak >= 6) {
    breakProbability = Math.min(breakProbability + 0.3, 0.95);
    reason = `[Bẻ Cầu Thông Minh] Chuỗi ${streak} ${currentResult} quá dài, khả năng bẻ cầu cao`;
  } else if (streak >= 3 && scoreDeviation > 3.5) {
    breakProbability = Math.min(breakProbability + 0.25, 0.9);
    reason = `[Bẻ Cầu Thông Minh] Biến động điểm số lớn (${scoreDeviation.toFixed(1)}), khả năng bẻ cầu tăng`;
  } else if (isStablePattern && last5.every(r => r === currentResult)) {
    breakProbability = Math.min(breakProbability + 0.2, 0.85);
    reason = `[Bẻ Cầu Thông Minh] Phát hiện mẫu lặp ${mostCommonPattern[0]}, có khả năng bẻ cầu`;
  } else {
    breakProbability = Math.max(breakProbability - 0.2, 0.1);
    reason = `[Theo Cầu Thông Minh] Không phát hiện mẫu bẻ mạnh, tiếp tục theo cầu`;
  }
  let prediction = breakProbability > 0.5 ? (currentResult === 'Tài' ? 2 : 1) : (currentResult === 'Tài' ? 1 : 2);
  return { prediction, breakProb: breakProbability, reason };
}

function trendAndProb(history) {
  const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
  if (streak >= 3) {
    if (breakProb > 0.6) {
      return currentResult === 'Tài' ? 2 : 1;
    }
    return currentResult === 'Tài' ? 1 : 2;
  }
  const last15 = history.slice(-15).map(h => h.result);
  if (!last15.length) return 0;
  const weights = last15.map((_, i) => Math.pow(1.3, i));
  const taiWeighted = weights.reduce((sum, w, i) => sum + (last15[i] === 'Tài' ? w : 0), 0);
  const xiuWeighted = weights.reduce((sum, w, i) => sum + (last15[i] === 'Xỉu' ? w : 0), 0);
  const totalWeight = taiWeighted + xiuWeighted;
  const last10 = last15.slice(-10);
  const patterns = [];
  if (last10.length >= 4) {
    for (let i = 0; i <= last10.length - 4; i++) {
      patterns.push(last10.slice(i, i + 4).join(','));
    }
  }
  const patternCounts = patterns.reduce((acc, p) => { acc[p] = (acc[p] || 0) + 1; return acc; }, {});
  const mostCommon = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
  if (mostCommon && mostCommon[1] >= 3) {
    const pattern = mostCommon[0].split(',');
    return pattern[pattern.length - 1] !== last10[last10.length - 1] ? 1 : 2;
  } else if (totalWeight > 0 && Math.abs(taiWeighted - xiuWeighted) / totalWeight >= 0.25) {
    return taiWeighted > xiuWeighted ? 1 : 2;
  }
  return last15[last15.length - 1] === 'Xỉu' ? 1 : 2;
}

function shortPattern(history) {
  const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
  if (streak >= 2) {
    if (breakProb > 0.6) {
      return currentResult === 'Tài' ? 2 : 1;
    }
    return currentResult === 'Tài' ? 1 : 2;
  }
  const last8 = history.slice(-8).map(h => h.result);
  if (!last8.length) return 0;
  const patterns = [];
  if (last8.length >= 2) {
    for (let i = 0; i <= last8.length - 2; i++) {
      patterns.push(last8.slice(i, i + 2).join(','));
    }
  }
  const patternCounts = patterns.reduce((acc, p) => { acc[p] = (acc[p] || 0) + 1; return acc; }, {});
  const mostCommon = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
  if (mostCommon && mostCommon[1] >= 2) {
    const pattern = mostCommon[0].split(',');
    return pattern[pattern.length - 1] !== last8[last8.length - 1] ? 1 : 2;
  }
  return last8[last8.length - 1] === 'Xỉu' ? 1 : 2;
}

function meanDeviation(history) {
  const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
  if (streak >= 2) {
    if (breakProb > 0.6) {
      return currentResult === 'Tài' ? 2 : 1;
    }
    return currentResult === 'Tài' ? 1 : 2;
  }
  const last12 = history.slice(-12).map(h => h.result);
  if (!last12.length) return 0;
  const taiCount = last12.filter(r => r === 'Tài').length;
  const xiuCount = last12.length - taiCount;
  const deviation = Math.abs(taiCount - xiuCount) / last12.length;
  if (deviation < 0.2) {
    return last12[last12.length - 1] === 'Xỉu' ? 1 : 2;
  }
  return xiuCount > taiCount ? 1 : 2;
}

function recentSwitch(history) {
  const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
  if (streak >= 2) {
    if (breakProb > 0.6) {
      return currentResult === 'Tài' ? 2 : 1;
    }
    return currentResult === 'Tài' ? 1 : 2;
  }
  const last10 = history.slice(-10).map(h => h.result);
  if (!last10.length) return 0;
  const switches = last10.slice(1).reduce((count, curr, idx) => count + (curr !== last10[idx] ? 1 : 0), 0);
  return switches >= 4 ? (last10[last10.length - 1] === 'Xỉu' ? 1 : 2) : (last10[last10.length - 1] === 'Xỉu' ? 1 : 2);
}

function isBadPattern(history) {
  const last15 = history.slice(-15).map(h => h.result);
  if (!last15.length) return false;
  const switches = last15.slice(1).reduce((count, curr, idx) => count + (curr !== last15[idx] ? 1 : 0), 0);
  const { streak } = detectStreakAndBreak(history);
  return switches >= 6 || streak >= 7;
}

function aiHtddLogic(history) {
  const recentHistory = history.slice(-5).map(h => h.result);
  const recentScores = history.slice(-5).map(h => h.totalScore || 0);
  const taiCount = recentHistory.filter(r => r === 'Tài').length;
  const xiuCount = recentHistory.filter(r => r === 'Xỉu').length;
  const { streak, currentResult } = detectStreakAndBreak(history);
  if (streak >= 2 && streak <= 4) {
    return {
      prediction: currentResult,
      reason: `[Theo Cầu Thông Minh] Chuỗi ngắn ${streak} ${currentResult}, tiếp tục theo cầu`,
      source: 'AI HTDD'
    };
  }
  if (history.length >= 3) {
    const last3 = history.slice(-3).map(h => h.result);
    if (last3.join(',') === 'Tài,Xỉu,Tài') {
      return { prediction: 'Xỉu', reason: '[Bẻ Cầu Thông Minh] Phát hiện mẫu 1T1X → tiếp theo nên đánh Xỉu', source: 'AI HTDD' };
    } else if (last3.join(',') === 'Xỉu,Tài,Xỉu') {
      return { prediction: 'Tài', reason: '[Bẻ Cầu Thông Minh] Phát hiện mẫu 1X1T → tiếp theo nên đánh Tài', source: 'AI HTDD' };
    }
  }
  if (history.length >= 4) {
    const last4 = history.slice(-4).map(h => h.result);
    if (last4.join(',') === 'Tài,Tài,Xỉu,Xỉu') {
      return { prediction: 'Tài', reason: '[Theo Cầu Thông Minh] Phát hiện mẫu 2T2X → tiếp theo nên đánh Tài', source: 'AI HTDD' };
    } else if (last4.join(',') === 'Xỉu,Xỉu,Tài,Tài') {
      return { prediction: 'Xỉu', reason: '[Theo Cầu Thông Minh] Phát hiện mẫu 2X2T → tiếp theo nên đánh Xỉu', source: 'AI HTDD' };
    }
  }
  if (history.length >= 7 && history.slice(-7).every(h => h.result === 'Xỉu')) {
    return { prediction: 'Tài', reason: '[Bẻ Cầu Thông Minh] Chuỗi Xỉu quá dài (7 lần) → dự đoán Tài', source: 'AI HTDD' };
  } else if (history.length >= 7 && history.slice(-7).every(h => h.result === 'Tài')) {
    return { prediction: 'Xỉu', reason: '[Bẻ Cầu Thông Minh] Chuỗi Tài quá dài (7 lần) → dự đoán Xỉu', source: 'AI HTDD' };
  }
  const avgScore = recentScores.reduce((sum, score) => sum + score, 0) / (recentScores.length || 1);
  if (avgScore > 11) {
    return { prediction: 'Tài', reason: `[Theo Cầu Thông Minh] Điểm trung bình cao (${avgScore.toFixed(1)}) → dự đoán Tài`, source: 'AI HTDD' };
  } else if (avgScore < 7) {
    return { prediction: 'Xỉu', reason: `[Theo Cầu Thông Minh] Điểm trung bình thấp (${avgScore.toFixed(1)}) → dự đoán Xỉu`, source: 'AI HTDD' };
  }
  if (taiCount > xiuCount + 1) {
    return { prediction: 'Xỉu', reason: `[Bẻ Cầu Thông Minh] Tài chiếm đa số (${taiCount}/${recentHistory.length}) → dự đoán Xỉu`, source: 'AI HTDD' };
  } else if (xiuCount > taiCount + 1) {
    return { prediction: 'Tài', reason: `[Bẻ Cầu Thông Minh] Xỉu chiếm đa số (${xiuCount}/${recentHistory.length}) → dự đoán Tài`, source: 'AI HTDD' };
  } else {
    const overallTai = history.filter(h => h.result === 'Tài').length;
    const overallXiu = history.filter(h => h.result === 'Xỉu').length;
    if (overallTai > overallXiu) {
      return { prediction: 'Xỉu', reason: '[Bẻ Cầu Thông Minh] Tổng thể Tài nhiều hơn → dự đoán Xỉu', source: 'AI HTDD' };
    } else {
      return { prediction: 'Tài', reason: '[Theo Cầu Thông Minh] Tổng thể Xỉu nhiều hơn hoặc bằng → dự đoán Tài', source: 'AI HTDD' };
    }
  }
}

function generatePrediction(history) {
  if (!history || history.length < 5) {
    const randomResult = Math.random() < 0.5 ? 'Tài' : 'Xỉu';
    return {
      prediction: randomResult,
      reason: 'Không đủ lịch sử, dự đoán ngẫu nhiên',
      do_tin_cay: 0.5,
      dudoan_vi: `Dự đoán ${randomResult}`
    };
  }
  const currentIndex = history[history.length - 1].session;
  const { streak } = detectStreakAndBreak(history);
  const trendPred = trendAndProb(history);
  const shortPred = shortPattern(history);
  const meanPred = meanDeviation(history);
  const switchPred = recentSwitch(history);
  const bridgePred = smartBridgeBreak(history);
  const aiPred = aiHtddLogic(history);
  modelPredictions['trend'][currentIndex] = trendPred;
  modelPredictions['short'][currentIndex] = shortPred;
  modelPredictions['mean'][currentIndex] = meanPred;
  modelPredictions['switch'][currentIndex] = switchPred;
  modelPredictions['bridge'][currentIndex] = bridgePred.prediction;
  const modelScores = {
    trend: evaluateModelPerformance(history, 'trend'),
    short: evaluateModelPerformance(history, 'short'),
    mean: evaluateModelPerformance(history, 'mean'),
    switch: evaluateModelPerformance(history, 'switch'),
    bridge: evaluateModelPerformance(history, 'bridge')
  };
  const weights = {
    trend: streak >= 3 ? 0.15 * modelScores.trend : 0.2 * modelScores.trend,
    short: streak >= 2 ? 0.2 * modelScores.short : 0.15 * modelScores.short,
    mean: 0.1 * modelScores.mean,
    switch: 0.1 * modelScores.switch,
    bridge: streak >= 3 ? 0.35 * modelScores.bridge : 0.3 * modelScores.bridge,
    aihtdd: streak >= 2 ? 0.3 : 0.25
  };
  let taiScore = 0;
  let xiuScore = 0;
  if (trendPred === 1) taiScore += weights.trend; else if (trendPred === 2) xiuScore += weights.trend;
  if (shortPred === 1) taiScore += weights.short; else if (shortPred === 2) xiuScore += weights.short;
  if (meanPred === 1) taiScore += weights.mean; else if (meanPred === 2) xiuScore += weights.mean;
  if (switchPred === 1) taiScore += weights.switch; else if (switchPred === 2) xiuScore += weights.switch;
  if (bridgePred.prediction === 1) taiScore += weights.bridge; else if (bridgePred.prediction === 2) xiuScore += weights.bridge;
  if (aiPred.prediction === 'Tài') taiScore += weights.aihtdd; else xiuScore += weights.aihtdd;
  if (isBadPattern(history)) {
    taiScore *= 0.5;
    xiuScore *= 0.5;
  }
  if (bridgePred.breakProb > 0.5) {
    if (bridgePred.prediction === 1) taiScore += 0.4; else xiuScore += 0.4;
  } else if (streak >= 3) {
    if (bridgePred.prediction === 1) taiScore += 0.35; else xiuScore += 0.35;
  }
  const finalPrediction = taiScore > xiuScore ? 'Tài' : 'Xỉu';
  const totalScore = taiScore + xiuScore;
  const confidence = totalScore > 0 ? (taiScore > xiuScore ? taiScore / totalScore : xiuScore / totalScore) : 0.5;
  return {
    prediction: finalPrediction,
    reason: `${aiPred.reason} | ${bridgePred.reason}`,
    do_tin_cay: confidence,
    dudoan_vi: `Dự đoán ${finalPrediction}`
  };
}

// --- HÀM TẠO DỮ LIỆU NGẪU NHIÊN THEO YÊU CẦU ---

function generateRandomScoreRange(prediction) {
  const scores = [];
  const count = 3; 
  if (prediction === 'Tài') {
    // Random numbers from 11 to 16
    for (let i = 0; i < count; i++) {
      scores.push(Math.floor(Math.random() * 6) + 11);
    }
  } else if (prediction === 'Xỉu') {
    // Random numbers from 5 to 10
    for (let i = 0; i < count; i++) {
      scores.push(Math.floor(Math.random() * 6) + 5);
    }
  }
  return scores.join(',');
}

function generateRandomConfidence() {
  const confidence = Math.random() * 0.5 + 0.5; // Random float between 0.5 and 1.0
  return (confidence * 100).toFixed(0);
}


// --- ENDPOINT ---

app.get('/sicbo', async (req, res) => {
  const apiData = await fetchData();
  if (!apiData || !apiData.data || !apiData.data.resultList) {
    return res.status(500).json({
      error: 'Không thể lấy dữ liệu từ API hoặc dữ liệu không hợp lệ.'
    });
  }

  const history = apiData.data.resultList.reverse().map(item => ({
    session: item.gameNum,
    score: item.score,
    dice1: item.facesList[0],
    dice2: item.facesList[1],
    dice3: item.facesList[2],
    totalScore: item.score,
    result: processResult(item.score)
  }));

  const lastResult = history[history.length - 1];
  
  // Lấy số từ chuỗi phiên và chuyển sang số nguyên
  const lastSessionNumber = parseInt(lastResult.session.substring(1));
  // Tăng số phiên lên 1
  const nextSessionNumber = lastSessionNumber + 1;
  // Format lại thành chuỗi 7 chữ số, có padding bằng '0'
  const nextGameNum = `#${nextSessionNumber.toString().padStart(7, '0')}`;
  
  const { prediction: dudoan_final } = generatePrediction(history);

  const finalJson = {
    phien: lastResult.session,
    xuc_xac_1: lastResult.dice1,
    xuc_xac_2: lastResult.dice2,
    xuc_xac_3: lastResult.dice3,
    tong: lastResult.score,
    ket_qua: lastResult.result,
    phien_hien_tai: nextGameNum,
    du_doan: dudoan_final,
    dudoan_vi: generateRandomScoreRange(dudoan_final),
    do_tin_cay: `${generateRandomConfidence()}%`,
  };

  res.json(finalJson);
});

// --- KHỞI ĐỘNG SERVER ---

app.listen(port, () => {
  console.log(`Server đang chạy tại http://localhost:${port}`);
  console.log(`Truy cập endpoint: http://localhost:${port}/sicbo`);
});
