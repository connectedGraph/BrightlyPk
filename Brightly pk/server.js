const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs').promises;
const path = require('path');
const session = require('express-session');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const os = require('os');

// 初始化Express
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 配置
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const USER_DATA_PATH = path.join(DATA_DIR, 'users.json');
const BATTLE_DATA_PATH = path.join(DATA_DIR, 'battles.json');
const QUESTION_DATA_PATH = path.join(DATA_DIR, 'questions.json');
const ERROR_BANK_PATH = path.join(DATA_DIR, 'errorBank.json');
const FRIEND_REQUESTS_PATH = path.join(DATA_DIR, 'friendRequests.json');
const FRIENDSHIPS_PATH = path.join(DATA_DIR, 'friendships.json');
const CHAT_MESSAGES_PATH = path.join(DATA_DIR, 'chatMessages.json');

// 定义难度对应的时间配置
const DIFFICULTY_TIME_CONFIG = {
  easy: { maxTime: 20000, minTime: 5000, baseScore: 80 },
  medium: { maxTime: 30000, minTime: 8000, baseScore: 100 },
  hard: { maxTime: 45000, minTime: 10000, baseScore: 150 }
};


// 获取本机IP地址
function getNetworkIP() {
    const interfaces = os.networkInterfaces();
    for (const interfaceName in interfaces) {
        for (const iface of interfaces[interfaceName]) {
            // 跳过内部接口和非IPv4
            if (iface.internal || iface.family !== 'IPv4') continue;
            
            // 检查是否是局域网IP
            if (iface.address.startsWith('192.168.') || 
                iface.address.startsWith('10.') || 
                iface.address.startsWith('172.')) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

// 内存缓存
let users = new Map();
let battles = new Map();
let questions = [];
let errorBank = new Map();
let matchQueue = {
  easy: [],
  medium: [],
  hard: []
};
let userWsMap = new Map();

// 好友功能缓存
let friendRequests = new Map(); // key: toUserId, value: array of requests
let friends = new Map(); // key: userId, value: array of friend user IDs
let chatMessages = new Map(); // key: `${userId1}-${userId2}`, value: array of messages

// 状态常量
const BattleState = {
  WAITING: 'waiting',
  PLAYING: 'playing',
  FINISHED: 'finished'
};

// 好友申请状态
const FriendRequestStatus = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected'
};
app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session 配置 - 在静态文件之前
app.use(session({
  name: 'quiz.sid',
  secret: 'quiz-battle-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  },
  rolling: true
}));

// 静态文件服务 - 只需要一个
app.use(express.static('.', {
  maxAge: '1d',
  etag: false,
  lastModified: false
}));


// 辅助函数：获取难度中文描述
function getDifficultyText(difficulty) {
  switch(difficulty) {
    case 'easy': return '简单';
    case 'medium': return '中等';
    case 'hard': return '困难';
    default: return '默认';
  }
}

// 辅助函数：生成聊天记录键
function getChatKey(userId1, userId2) {
  return [userId1, userId2].sort().join('-');
}

//------------------------------ 随机数与洗牌
// 基于当前时间的随机数生成器
function getTimeBasedRandom() {
  // 使用当前时间戳 + 高性能计数器的组合
  const timeFactor = Date.now() % 1000000;
  const perfFactor = performance ? performance.now() % 1000000 : Math.random() * 1000000;
  return ((timeFactor + perfFactor) % 1000000) / 1000000;
}

// Fisher-Yates 洗牌算法（基于时间随机）
function timeBasedShuffle(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(getTimeBasedRandom() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
//------------------------------
// 初始化数据
async function initData() {
  try {
    await fs.access(DATA_DIR);
  } catch {
    await fs.mkdir(DATA_DIR);
  }

  // 初始化用户数据
  try {
    const userData = await fs.readFile(USER_DATA_PATH, 'utf8');
    const parsed = JSON.parse(userData);
    parsed.forEach(user => users.set(user.id, user));
  } catch {
    await fs.writeFile(USER_DATA_PATH, '[]');
  }

  // 初始化对战数据
  try {
    const battleData = await fs.readFile(BATTLE_DATA_PATH, 'utf8');
    const parsed = JSON.parse(battleData);
    parsed.forEach(battle => battles.set(battle.id, battle));
  } catch {
    await fs.writeFile(BATTLE_DATA_PATH, '[]');
  }

  // 初始化题目数据
  try {
    const questionData = await fs.readFile(QUESTION_DATA_PATH, 'utf8');
    questions = JSON.parse(questionData);
    console.log(`加载了 ${questions.length} 道题目`);
  } catch (error) {
    console.log('初始化示例题目数据...');
    await fs.writeFile(QUESTION_DATA_PATH, JSON.stringify(questions, null, 2));
  }

  // 初始化错题数据
  try {
    const errorData = await fs.readFile(ERROR_BANK_PATH, 'utf8');
    const parsed = JSON.parse(errorData);
    parsed.forEach(item => errorBank.set(item.userId, item.errors));
  } catch {
    await fs.writeFile(ERROR_BANK_PATH, '[]');
  }

  // 初始化好友申请数据
  try {
    const friendRequestsData = await fs.readFile(FRIEND_REQUESTS_PATH, 'utf8');
    const parsedRequests = JSON.parse(friendRequestsData);
    parsedRequests.forEach(({ toUserId, requests }) => {
      friendRequests.set(toUserId, requests);
    });
  } catch {
    await fs.writeFile(FRIEND_REQUESTS_PATH, '[]');
  }

  // 初始化好友关系数据
  try {
    const friendshipsData = await fs.readFile(FRIENDSHIPS_PATH, 'utf8');
    const parsedFriendships = JSON.parse(friendshipsData);
    parsedFriendships.forEach(({ userId, friendIds }) => {
      friends.set(userId, friendIds);
    });
  } catch {
    await fs.writeFile(FRIENDSHIPS_PATH, '[]');
  }

  // 初始化聊天记录数据
  try {
    const chatMessagesData = await fs.readFile(CHAT_MESSAGES_PATH, 'utf8');
    const parsedChats = JSON.parse(chatMessagesData);
    parsedChats.forEach(({ chatKey, messages }) => {
      chatMessages.set(chatKey, messages);
    });
  } catch {
    await fs.writeFile(CHAT_MESSAGES_PATH, '[]');
  }

  console.log('数据初始化完成');
}

// 持久化数据
async function persistUsers() {
  const userArray = Array.from(users.values());
  await fs.writeFile(USER_DATA_PATH, JSON.stringify(userArray, null, 2));
}

async function persistBattles() {
  const battleArray = Array.from(battles.values());
  await fs.writeFile(BATTLE_DATA_PATH, JSON.stringify(battleArray, null, 2));
}

async function persistErrorBank() {
  const errorArray = Array.from(errorBank.entries()).map(([userId, errors]) => ({
    userId,
    errors
  }));
  await fs.writeFile(ERROR_BANK_PATH, JSON.stringify(errorArray, null, 2));
}

// 持久化好友数据
async function persistFriendData() {
  try {
    // 持久化好友申请
    const friendRequestsArray = Array.from(friendRequests.entries()).map(([toUserId, requests]) => ({
      toUserId,
      requests
    }));
    await fs.writeFile(FRIEND_REQUESTS_PATH, JSON.stringify(friendRequestsArray, null, 2));
    
    // 持久化好友关系
    const friendshipsArray = Array.from(friends.entries()).map(([userId, friendIds]) => ({
      userId,
      friendIds
    }));
    await fs.writeFile(FRIENDSHIPS_PATH, JSON.stringify(friendshipsArray, null, 2));
    
    // 持久化聊天记录
    const chatMessagesArray = Array.from(chatMessages.entries()).map(([chatKey, messages]) => ({
      chatKey,
      messages
    }));
    await fs.writeFile(CHAT_MESSAGES_PATH, JSON.stringify(chatMessagesArray, null, 2));
    
    console.log('好友数据持久化完成');
  } catch (error) {
    console.error('持久化好友数据失败:', error);
  }
}

// 用户相关API
app.post('/api/register', async (req, res) => {
  const { username, password, email } = req.body;
  
  if (Array.from(users.values()).some(u => u.username === username)) {
    return res.status(400).json({ error: '用户名已存在' });
  }

  const user = {
    id: `user-${uuidv4()}`,
    username,
    password,
    email,
    score: 1000,
    wins: 0,
    losses: 0,
    createdAt: new Date().toISOString()
  };

  users.set(user.id, user);
  await persistUsers();
  
  req.session.userId = user.id;
  res.status(201).json({ 
    id: user.id, 
    username: user.username, 
    score: user.score 
  });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = Array.from(users.values()).find(
    u => u.username === username && u.password === password
  );

  if (!user) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  req.session.userId = user.id;
  res.json({
    id: user.id,
    username: user.username,
    score: user.score,
    wins: user.wins,
    losses: user.losses
  });
});

app.get('/api/user', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: '未登录' });
  }

  const user = users.get(req.session.userId);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }

  res.json({
    id: user.id,
    username: user.username,
    score: user.score,
    wins: user.wins,
    losses: user.losses,
    email: user.email
  });
});

// 题目相关API
app.get('/api/questions', (req, res) => {
  res.json(questions);
});

// 错题本API
app.get('/api/error-bank', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: '未登录' });
  }

  const errors = errorBank.get(req.session.userId) || [];
  const enrichedErrors = errors.map(error => {
    const originalQuestion = questions.find(q => q.id === error.questionId);
    if (originalQuestion) {
      return {
        ...error,
        content: originalQuestion.content,
        analysis: originalQuestion.analysis || error.analysis,
        type: originalQuestion.type || error.type,
        difficulty: originalQuestion.difficulty || error.difficulty
      };
    }
    return error;
  });
  
  res.json(enrichedErrors);
});

// 对战相关API
app.get('/api/battles/:id', (req, res) => {
  const battle = battles.get(req.params.id);
  if (!battle) {
    return res.status(404).json({ error: '对战不存在' });
  }
  res.json(battle);
});

// 按难度筛选题目
function getRandomQuestions(difficulty, count = 5) {
  console.log(`正在为难度 ${difficulty} 选择 ${count} 道题目...`);
  
  // 目标题型分布：2单选 + 1多选 + 2填空
  const TARGET_DISTRIBUTION = {
    choice: 2,
    multi: 1, 
    fill: 2
  };
  
  // 按难度和题型分组
  const filteredByType = {
    choice: questions.filter(q => q.difficulty === difficulty && q.type === 'choice'),
    multi: questions.filter(q => q.difficulty === difficulty && q.type === 'multi'),
    fill: questions.filter(q => q.difficulty === difficulty && q.type === 'fill')
  };
  
  console.log(`找到 ${filteredByType.choice.length} 道单选，${filteredByType.multi.length} 道多选，${filteredByType.fill.length} 道填空`);
  
  let result = [];
  
  // 为每种题型抽题，如果数量不足则从其他难度补充
  Object.entries(TARGET_DISTRIBUTION).forEach(([type, targetCount]) => {
    const available = filteredByType[type];
    
    if (available.length >= targetCount) {
      // 当前难度该题型题目足够
      result.push(...timeBasedShuffle(available).slice(0, targetCount));
    } else {
      // 当前难度题目不足，先用完当前难度的，再从其他难度补充
      const currentDifficultyQuestions = timeBasedShuffle(available);
      result.push(...currentDifficultyQuestions);
      
      const needed = targetCount - currentDifficultyQuestions.length;
      if (needed > 0) {
        const otherDifficultyQuestions = questions.filter(
          q => q.difficulty !== difficulty && q.type === type
        );
        const shuffledOther = timeBasedShuffle(otherDifficultyQuestions);
        result.push(...shuffledOther.slice(0, needed));
      }
    }
  });
  
  console.log(`最终选择 ${result.length} 道题目（${TARGET_DISTRIBUTION.choice}单选+${TARGET_DISTRIBUTION.multi}多选+${TARGET_DISTRIBUTION.fill}填空）`);
  return timeBasedShuffle(result); // 最后再次洗牌混合题型
}

// 计算得分 根据难度对应时间调整奖励衰减
function calculateScore(timeTaken, difficulty) {
    const config = DIFFICULTY_TIME_CONFIG[difficulty] || DIFFICULTY_TIME_CONFIG.medium;
    const { baseScore, maxTime, minTime } = config;
    
    if (timeTaken <= minTime) return baseScore;
    if (timeTaken >= maxTime) return Math.round(baseScore * 0.3);
    
    return Math.round(
        baseScore - (baseScore * 0.7) * (timeTaken - minTime) / (maxTime - minTime)
    );
}

// 查找对手
function findOpponentInQueue(currentUserId, difficulty) {
  const queue = matchQueue[difficulty] || [];
  return queue.findIndex(userId => userId !== currentUserId);
}

// 对战结束检测
function checkBattleCompletion(battleId) {
  const battle = battles.get(battleId);
  if (!battle || battle.state !== BattleState.PLAYING) return;

  const allQuestionsAnswered = battle.players.every(player => 
    player.answers.length === battle.questions.length
  );

  if (allQuestionsAnswered) {
    console.log('对战完成，开始结算:', battleId);
    handleBattleEnd(battleId);
  }
}

// 处理对战结束
function handleBattleEnd(battleId) {
  const battle = battles.get(battleId);
  if (!battle || battle.state === BattleState.FINISHED) return;

  console.log('开始处理对战结束:', battleId);

  const [player1, player2] = battle.players;
  
  // 计算总分
  player1.totalScore = player1.answers.reduce((sum, answer) => sum + (answer.score || 0), 0);
  player2.totalScore = player2.answers.reduce((sum, answer) => sum + (answer.score || 0), 0);

  console.log('玩家得分:', {
    player1: { userId: player1.userId, score: player1.totalScore, answers: player1.answers },
    player2: { userId: player2.userId, score: player2.totalScore, answers: player2.answers }
  });

  // 确定胜负
  let winner, loser;
  if (player1.totalScore > player2.totalScore) {
    winner = player1;
    loser = player2;
  } else if (player2.totalScore > player1.totalScore) {
    winner = player2;
    loser = player1;
  } else {
    // 平局处理
    battle.state = BattleState.FINISHED;
    battle.endTime = new Date().toISOString();
    battle.result = {
      type: 'draw',
      scores: {
        [player1.userId]: player1.totalScore,
        [player2.userId]: player2.totalScore
      }
    };

    // 平局双方各加5分
    const user1 = users.get(player1.userId);
    const user2 = users.get(player2.userId);
    user1.score += 5;
    user2.score += 5;
    users.set(user1.id, user1);
    users.set(user2.id, user2);
    
    // 记录错题（平局也要记录）
    recordErrors(battle);
    
    persistUsers();
    persistBattles();
    
    // 发送平局结果
    sendBattleResult(battle);
    return;
  }

  // 根据难度确定积分变动
  let scoreChange = 10;
  switch(battle.difficulty) {
    case 'medium': scoreChange = 20; break;
    case 'hard': scoreChange = 50; break;
  }

  // 处理胜负结果
  battle.state = BattleState.FINISHED;
  battle.endTime = new Date().toISOString();
  battle.result = {
    type: 'win',
    winner: winner.userId,
    loser: loser.userId,
    scores: {
      [winner.userId]: winner.totalScore,
      [loser.userId]: loser.totalScore
    },
    scoreChange: scoreChange
  };

  // 更新用户数据
  const winnerUser = users.get(winner.userId);
  const loserUser = users.get(loser.userId);
  
  winnerUser.score += scoreChange;
  loserUser.score = Math.max(0, loserUser.score - Math.floor(scoreChange / 2));
  winnerUser.wins += 1;
  loserUser.losses += 1;
  
  users.set(winnerUser.id, winnerUser);
  users.set(loserUser.id, loserUser);

  // 记录错题
  console.log('开始记录错题...');
  recordErrors(battle);
  
  // 持久化数据
  persistUsers();
  persistBattles();
  persistErrorBank();

  console.log('对战结束处理完成，发送结果');
  // 发送结果
  sendBattleResult(battle);
}

// 记录错题
function recordErrors(battle) {
  console.log('开始记录错题，对战ID:', battle.id);
  
  battle.questions.forEach((q, index) => {
    const originalQuestion = questions.find(origQ => origQ.id === q.id);
    
    // 检查玩家1的答题情况
    const p1Answer = battle.players[0].answers[index];
    if (p1Answer && !p1Answer.correct) {
      console.log(`记录玩家1错题: ${battle.players[0].userId}, 题目${index}`);
      const errors = errorBank.get(battle.players[0].userId) || [];
      // 避免重复记录
      const alreadyRecorded = errors.some(err => 
        err.questionId === q.id && err.battleId === battle.id
      );
      if (!alreadyRecorded) {
        errors.push({
          questionId: q.id,
          content: originalQuestion ? originalQuestion.content : q.content,
          userAnswer: p1Answer.answer,
          correctAnswer: originalQuestion ? originalQuestion.answer : q.answer,
          analysis: originalQuestion ? originalQuestion.analysis : q.analysis,
          difficulty: q.difficulty,
          type: q.type,
          battleId: battle.id,
          timestamp: new Date().toISOString()
        });
        errorBank.set(battle.players[0].userId, errors);
      }
    }

    // 检查玩家2的答题情况
    const p2Answer = battle.players[1].answers[index];
    if (p2Answer && !p2Answer.correct) {
      console.log(`记录玩家2错题: ${battle.players[1].userId}, 题目${index}`);
      const errors = errorBank.get(battle.players[1].userId) || [];
      // 避免重复记录
      const alreadyRecorded = errors.some(err => 
        err.questionId === q.id && err.battleId === battle.id
      );
      if (!alreadyRecorded) {
        errors.push({
          questionId: q.id,
          content: originalQuestion ? originalQuestion.content : q.content,
          userAnswer: p2Answer.answer,
          correctAnswer: originalQuestion ? originalQuestion.answer : q.answer,
          analysis: originalQuestion ? originalQuestion.analysis : q.analysis,
          difficulty: q.difficulty,
          type: q.type,
          battleId: battle.id,
          timestamp: new Date().toISOString()
        });
        errorBank.set(battle.players[1].userId, errors);
      }
    }
  });
  
  console.log('错题记录完成');
}

// 发送对战结果
function sendBattleResult(battle) {
  const resultData = {
    type: 'battle_end',
    battleId: battle.id,
    result: battle.result,
    scores: {
      [battle.players[0].userId]: battle.players[0].totalScore,
      [battle.players[1].userId]: battle.players[1].totalScore
    },
    difficulty: battle.difficulty
  };

  if (battle.result.type === 'win') {
    resultData.scoreChange = battle.result.scoreChange;
  }

  // 发送给双方玩家
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && 
        (client.userId === battle.players[0].userId || client.userId === battle.players[1].userId)) {
      client.send(JSON.stringify(resultData));
    }
  });
}

// WebSocket连接处理
wss.on('connection', (ws, req) => {
  console.log('新的客户端连接:', req.socket.remoteAddress);
  let userId = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'auth':
          ws.userId = data.userId;
          userWsMap.set(data.userId, ws);
          console.log(`用户 ${data.userId} 已通过WebSocket验证`);
          break;
          
        case 'match_join':
          if (!ws.userId) return;
          
          const { difficulty = 'easy' } = data;
          const targetQueue = matchQueue[difficulty];

          // 加入队列
          if (!targetQueue.includes(ws.userId)) {
            targetQueue.push(ws.userId);
          }

          // 发送匹配状态
          ws.send(JSON.stringify({
            type: 'match_status',
            status: 'waiting',
            message: `已加入${getDifficultyText(difficulty)}难度匹配队列`,
            queueCount: targetQueue.length,
            onlineCount: userWsMap.size
          }));

          // 查找对手
          const opponentIndex = findOpponentInQueue(ws.userId, difficulty);
          if (opponentIndex !== -1) {
            const opponentId = targetQueue.splice(opponentIndex, 1)[0];
            const currentUserIndex = targetQueue.indexOf(ws.userId);
            if (currentUserIndex !== -1) {
              targetQueue.splice(currentUserIndex, 1);
            }

            // 创建对战
            const battleId = `battle-${uuidv4()}`;
            const battleQuestions = getRandomQuestions(difficulty, 5);
            
            // 获取对手连接
            const opponentWs = userWsMap.get(opponentId);
            if (!opponentWs) {
              ws.send(JSON.stringify({
                type: 'match_status',
                status: 'error',
                message: '对手已离开'
              }));
              return;
            }
            
            // 创建对战数据
            const battle = {
              id: battleId,
              difficulty: difficulty,
              state: BattleState.WAITING,
              startTime: null,
              endTime: null,
              players: [
                {
                  userId: ws.userId,
                  score: 0,
                  progress: 0,
                  answers: []
                },
                {
                  userId: opponentId,
                  score: 0,
                  progress: 0,
                  answers: []
                }
              ],
              questions: battleQuestions
            };
            
            battles.set(battleId, battle);
            
            // 通知双方匹配成功
            const selfUser = users.get(ws.userId);
            const opponentUser = users.get(opponentId);
            
            ws.send(JSON.stringify({
              type: 'match_found',
              battleId,
              difficulty: difficulty,
              opponent: opponentUser.username,
              questions: battle.questions
            }));

            opponentWs.send(JSON.stringify({
              type: 'match_found',
              battleId,
              difficulty: difficulty,
              opponent: selfUser.username,
              questions: battle.questions
            }));
            
            // 3秒后开始对战
            setTimeout(() => {
              const battle = battles.get(battleId);
              if (battle) {
                battle.state = BattleState.PLAYING;
                battle.startTime = new Date().toISOString();
                battles.set(battleId, battle);
                
                // 通知双方开始对战
                ws.send(JSON.stringify({
                  type: 'battle_start',
                  battleId
                }));
                
                opponentWs.send(JSON.stringify({
                  type: 'battle_start',
                  battleId
                }));
              }
            }, 3000);
          }
          break;

        case 'match_cancel':
          if (!ws.userId) return;
          Object.values(matchQueue).forEach(queue => {
            const index = queue.indexOf(ws.userId);
            if (index !== -1) {
              queue.splice(index, 1);
            }
          });
          ws.send(JSON.stringify({
            type: 'match_status',
            status: 'cancelled',
            message: '已取消匹配'
          }));
          break;

        case 'battle_ready':
          if (data.battleId) {
            ws.currentBattleId = data.battleId;
          }
          break;

        case 'answer_progress':
          if (!ws.userId || !data.battleId) return;
          
          const battle = battles.get(data.battleId);
          if (!battle || battle.state !== BattleState.PLAYING) return;
          
          const { questionIndex, answer, timeTaken, score } = data;
          const question = battle.questions[questionIndex];
          const isCorrect = answer === question.answer;
          
          // 更新玩家进度
          const playerIndex = battle.players.findIndex(p => p.userId === ws.userId);
          if (playerIndex !== -1) {
            battle.players[playerIndex].progress = questionIndex + 1;
            battle.players[playerIndex].answers[questionIndex] = {
              answer,
              correct: isCorrect,
              timeTaken,
              score: score || 0
            };
            
            // 计算当前总分
            const currentScore = battle.players[playerIndex].answers.reduce((sum, a) => sum + (a.score || 0), 0);
            
            battles.set(data.battleId, battle);
            
            // 广播进度更新
            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN && 
                  (client.userId === battle.players[0].userId || client.userId === battle.players[1].userId)) {
                client.send(JSON.stringify({
                  type: 'battle_update',
                  battleId: data.battleId,
                  playerId: ws.userId,
                  progress: battle.players[playerIndex].progress,
                  score: currentScore
                }));
              }
            });

            // 检查对战是否完成
            checkBattleCompletion(data.battleId);
          }
          break;

        case 'chat_message':
          console.log('收到聊天消息:', data);
          
          if (!ws.userId) {
            ws.send(JSON.stringify({
              type: 'chat_error',
              message: '未登录，无法发送消息'
            }));
            return;
          }
          
          const { toUserId, content } = data;
          
          if (!toUserId || !content) {
            ws.send(JSON.stringify({
              type: 'chat_error',
              message: '缺少接收用户ID或消息内容'
            }));
            return;
          }
          
          // 检查是否是好友
          const userFriends = friends.get(ws.userId) || [];
          if (!userFriends.includes(toUserId)) {
            ws.send(JSON.stringify({
              type: 'chat_error',
              message: '不是好友，无法发送消息'
            }));
            return;
          }
          
          // 创建消息对象
          const messageObj = {
            id: `msg-${uuidv4()}`,
            from: ws.userId,
            to: toUserId,
            content: content,
            timestamp: new Date().toISOString()
          };
          
          // 保存消息到聊天记录
          const chatKey = getChatKey(ws.userId, toUserId);
          const messages = chatMessages.get(chatKey) || [];
          messages.push(messageObj);
          chatMessages.set(chatKey, messages);
          
          // 持久化聊天记录
          await persistFriendData();
          
          // 发送给接收方
          const toUserWs = userWsMap.get(toUserId);
          if (toUserWs && toUserWs.readyState === WebSocket.OPEN) {
            toUserWs.send(JSON.stringify({
              type: 'chat_message',
              message: messageObj
            }));
            console.log(`消息已转发给 ${toUserId}`);
          } else {
            console.log(`用户 ${toUserId} 不在线，消息已保存`);
          }
          
          // 也发送给自己（用于确认发送成功）
          ws.send(JSON.stringify({
            type: 'chat_message_sent',
            message: messageObj
          }));
          
          console.log(`消息已发送: ${ws.userId} -> ${toUserId}`);
          break;
          
        default:
          console.log('未知消息类型：', data.type);
      }
    } catch (error) {
      console.error('WebSocket消息处理错误:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: '消息处理失败'
      }));
    }
  });

  ws.on('close', () => {
    if (ws.userId) {
      userWsMap.delete(ws.userId);
      Object.values(matchQueue).forEach(queue => {
        const index = queue.indexOf(ws.userId);
        if (index !== -1) {
          queue.splice(index, 1);
        }
      });
      console.log(`用户 ${ws.userId} 断开连接`);
    }
  });
});

// 获取用户对战答题统计
app.get('/api/user/battle-stats', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: '未登录' });
  }

  const userId = req.session.userId;
  let totalQuestions = 0;
  let correctAnswers = 0;

  // 遍历所有对战记录
  battles.forEach(battle => {
    if (battle.state === BattleState.FINISHED) {
      const player = battle.players.find(p => p.userId === userId);
      if (player && player.answers) {
        totalQuestions += player.answers.length;
        correctAnswers += player.answers.filter(answer => answer.correct).length;
      }
    }
  });

  const accuracy = totalQuestions > 0 ? (correctAnswers / totalQuestions * 100).toFixed(1) : 0;

  res.json({
    totalQuestions,
    correctAnswers,
    accuracy: parseFloat(accuracy),
    totalBattles: Array.from(battles.values()).filter(battle => 
      battle.state === BattleState.FINISHED && 
      battle.players.some(p => p.userId === userId)
    ).length
  });
});

// 获取指定对战的详细答题情况
app.get('/api/battles/:id/stats', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: '未登录' });
  }

  const battle = battles.get(req.params.id);
  if (!battle) {
    return res.status(404).json({ error: '对战不存在' });
  }

  const player = battle.players.find(p => p.userId === req.session.userId);
  if (!player) {
    return res.status(403).json({ error: '无权访问此对战' });
  }

  const totalQuestions = player.answers.length;
  const correctAnswers = player.answers.filter(answer => answer.correct).length;
  const accuracy = totalQuestions > 0 ? (correctAnswers / totalQuestions * 100).toFixed(1) : 0;

  res.json({
    battleId: battle.id,
    difficulty: battle.difficulty,
    totalQuestions,
    correctAnswers,
    accuracy: parseFloat(accuracy),
    answers: player.answers.map((answer, index) => ({
      questionIndex: index,
      question: battle.questions[index].content,
      userAnswer: answer.answer,
      correctAnswer: battle.questions[index].answer,
      isCorrect: answer.correct,
      timeTaken: answer.timeTaken,
      score: answer.score
    }))
  });
});

// 导出错题本为 Markdown
app.get('/api/error-bank/export', (req, res) => {
  console.log('收到错题本导出请求');
  
  if (!req.session.userId) {
    console.log('用户未登录');
    return res.status(401).json({ error: '未登录' });
  }

  try {
    const userId = req.session.userId;
    const errors = errorBank.get(userId) || [];
    
    console.log(`用户 ${userId} 的错题数量: ${errors.length}`);

    if (errors.length === 0) {
      return res.status(400).json({ error: '错题本为空' });
    }

    // 构建 Markdown 内容
    let markdownContent = '# 错题本\n\n';
    markdownContent += `导出时间：${new Date().toLocaleString('zh-CN')}\n`;
    markdownContent += `错题数量：${errors.length}\n\n`;
    markdownContent += '---\n\n';

    errors.forEach((error, index) => {
      markdownContent += `## 第 ${index + 1} 题\n\n`;
      markdownContent += `**题目：** ${error.content || '题目内容缺失'}\n\n`;
      markdownContent += `**你的答案：** ${error.userAnswer || '未作答'}\n\n`;
      markdownContent += `**正确答案：** ${error.correctAnswer || '答案缺失'}\n\n`;
      markdownContent += `**解析：** ${error.analysis || '暂无解析'}\n\n`;
      markdownContent += `**难度：** ${getDifficultyText(error.difficulty)}\n\n`;
      markdownContent += `**错误时间：** ${new Date(error.timestamp).toLocaleString('zh-CN')}\n\n`;
      markdownContent += '---\n\n';
    });

    console.log('Markdown 内容生成完成，长度:', markdownContent.length);

    // 设置响应头
    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', 'attachment; filename=errorbook.md');
    
    // 发送内容
    res.send(markdownContent);
    console.log('响应发送成功');
    
  } catch (error) {
    console.error('导出错题本时发生错误:', error);
    res.status(500).json({ error: '服务器内部错误: ' + error.message });
  }
});

// 清空错题本
app.delete('/api/error-bank/clear', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: '未登录' });
  }

  try {
    errorBank.set(req.session.userId, []);
    await persistErrorBank();
    res.json({ success: true, message: '错题本已清空' });
  } catch (err) {
    res.status(500).json({ error: '清空错题本失败' });
  }
});

// 好友功能API

// 获取所有用户（用于通过用户名查找）
app.get('/api/users', (req, res) => {
  const userArray = Array.from(users.values()).map(user => ({
    id: user.id,
    username: user.username,
    score: user.score
  }));
  res.json(userArray);
});

// 发送好友申请
app.post('/api/friend-request', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: '未登录' });
  }

  const { toUserId, message } = req.body;
  const fromUserId = req.session.userId;

  if (!toUserId) {
    return res.status(400).json({ error: '缺少目标用户ID' });
  }

  // 不能添加自己为好友
  if (fromUserId === toUserId) {
    return res.status(400).json({ error: '不能添加自己为好友' });
  }

  // 检查目标用户是否存在
  const toUser = users.get(toUserId);
  if (!toUser) {
    return res.status(404).json({ error: '目标用户不存在' });
  }

  // 检查是否已经是好友
  const userFriends = friends.get(fromUserId) || [];
  if (userFriends.includes(toUserId)) {
    return res.status(400).json({ error: '已经是好友' });
  }

  // 检查是否已经发送过申请
  const existingRequests = friendRequests.get(toUserId) || [];
  const hasPendingRequest = existingRequests.some(req => 
    req.fromUserId === fromUserId && req.status === FriendRequestStatus.PENDING
  );

  if (hasPendingRequest) {
    return res.status(400).json({ error: '已经发送过好友申请' });
  }

  // 创建好友申请
  const request = {
    id: `friend-request-${uuidv4()}`,
    fromUserId,
    toUserId,
    message: message || '',
    status: FriendRequestStatus.PENDING,
    createdAt: new Date().toISOString()
  };

  // 保存申请
  friendRequests.set(toUserId, [...existingRequests, request]);
  await persistFriendData();

  // 通知目标用户
  const toUserWs = userWsMap.get(toUserId);
  if (toUserWs) {
    toUserWs.send(JSON.stringify({
      type: 'friend_request_received',
      request: {
        ...request,
        fromUsername: users.get(fromUserId).username
      }
    }));
  }

  res.json({ success: true, message: '好友申请已发送' });
});

// 获取好友申请列表
app.get('/api/friend-requests', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: '未登录' });
  }

  const userId = req.session.userId;
  const requests = friendRequests.get(userId) || [];

  // 补充申请者信息
  const enrichedRequests = requests.map(request => {
    const fromUser = users.get(request.fromUserId);
    return {
      ...request,
      fromUsername: fromUser ? fromUser.username : '未知用户'
    };
  });

  res.json(enrichedRequests);
});

// 处理好友申请
app.post('/api/friend-request/respond', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: '未登录' });
  }

  const { requestId, action } = req.body;
  const userId = req.session.userId;

  if (!requestId || !action) {
    return res.status(400).json({ error: '缺少参数' });
  }

  // 找到申请
  const requests = friendRequests.get(userId) || [];
  const requestIndex = requests.findIndex(req => req.id === requestId);

  if (requestIndex === -1) {
    return res.status(404).json({ error: '好友申请不存在' });
  }

  const request = requests[requestIndex];

  if (action === 'accept') {
    // 添加好友关系
    const userFriends = friends.get(userId) || [];
    const fromUserFriends = friends.get(request.fromUserId) || [];

    if (!userFriends.includes(request.fromUserId)) {
      userFriends.push(request.fromUserId);
      friends.set(userId, userFriends);
    }

    if (!fromUserFriends.includes(userId)) {
      fromUserFriends.push(userId);
      friends.set(request.fromUserId, fromUserFriends);
    }

    // 更新申请状态
    requests[requestIndex].status = FriendRequestStatus.ACCEPTED;
    friendRequests.set(userId, requests);
    
    await persistFriendData();

    // 通知申请者
    const fromUserWs = userWsMap.get(request.fromUserId);
    if (fromUserWs) {
      fromUserWs.send(JSON.stringify({
        type: 'friend_request_accepted',
        fromUserId: userId,
        username: users.get(userId).username
      }));
    }

    res.json({ success: true, message: '已接受好友申请' });

  } else if (action === 'reject') {
    // 更新申请状态
    requests[requestIndex].status = FriendRequestStatus.REJECTED;
    friendRequests.set(userId, requests);
    await persistFriendData();
    
    res.json({ success: true, message: '已拒绝好友申请' });
  } else {
    res.status(400).json({ error: '无效的操作' });
  }
});

// 获取好友列表
app.get('/api/friends', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: '未登录' });
  }

  const userId = req.session.userId;
  const friendIds = friends.get(userId) || [];

  // 补充好友信息
  const friendList = friendIds.map(friendId => {
    const friend = users.get(friendId);
    return {
      id: friendId,
      username: friend ? friend.username : '未知用户',
      online: userWsMap.has(friendId), // 在线状态
      score: friend ? friend.score : 0,
      wins: friend ? friend.wins : 0,
      losses: friend ? friend.losses : 0
    };
  });

  res.json(friendList);
});

// 获取聊天记录
app.get('/api/chat/:friendId', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: '未登录' });
  }

  const userId = req.session.userId;
  const friendId = req.params.friendId;

  // 检查是否是好友
  const userFriends = friends.get(userId) || [];
  if (!userFriends.includes(friendId)) {
    return res.status(403).json({ error: '不是好友，无法查看聊天记录' });
  }

  // 获取聊天记录
  const chatKey = getChatKey(userId, friendId);
  const messages = chatMessages.get(chatKey) || [];

  res.json(messages);
});


app.use((req, res, next) => {
  console.log('=== Session 调试 ===');
  console.log('请求路径:', req.path);
  console.log('Session ID:', req.sessionID);
  console.log('Session 数据:', req.session);
  console.log('==================');
  next();
});
// 默认路由，返回 index.html
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

async function startServer() {
  await initData();
  
    server.listen(PORT, HOST, () => {
      console.log('🚀 服务器启动成功!');
      console.log('================================');
      console.log(`📍 本地访问: http://localhost:${PORT}`);
      console.log(`🌐 公网访问: http://47.114.126.231:${PORT}`);
      console.log(`🌐 域名访问: http://你的域名`); // 如果将来绑定域名
      console.log('================================');
    });
}

// 启动服务器
startServer().catch(console.error);


// 优雅关闭
// process.on('SIGINT', () => {
//     console.log('\n🛑 正在关闭服务器...');
//     server.close(() => {
//         console.log('✅ 服务器已关闭');
//         process.exit(0);
//     });
// });

// 启动服务器
// initData().then(() => {
//   server.listen(PORT, () => {
//     console.log(`服务器运行在 http://localhost:${PORT}`);
//   });
// });
// 启动服务器
