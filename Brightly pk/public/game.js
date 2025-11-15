// 基础配置
const baseUrl = 'http://localhost:3000/api';
let currentUser = null;
let ws = null;
let battleId = null;
let currentQuestionIndex = 0;
let questions = [];
let matchTimer = null;

// 模块切换函数
function showModule(moduleId) {
    // 隐藏所有模块
    document.querySelectorAll('div[id$="Module"]').forEach(module => {
        module.style.display = 'none';
    });
    // 显示目标模块
    document.getElementById(moduleId).style.display = 'block';
}

// 1. 用户注册
async function registerUser() {
    const username = document.getElementById('regUsername').value.trim();
    const password = document.getElementById('regPassword').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const regMsg = document.getElementById('regMsg');

    if (!username || !password || !email) {
        regMsg.textContent = '请填写完整信息';
        return;
    }

    try {
        const res = await axios.post(`${baseUrl}/register`, {
            username,
            password,
            email
        });
        regMsg.textContent = `注册成功！你的用户ID：${res.data.id}`;
        // 注册成功后自动跳转登录
        setTimeout(() => showModule('loginModule'), 1500);
    } catch (err) {
        regMsg.textContent = err.response?.data?.error || '注册失败，请重试';
    }
}

// 2. 用户登录
async function loginUser() {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value.trim();
    const loginMsg = document.getElementById('loginMsg');

    if (!username || !password) {
        loginMsg.textContent = '请填写用户名和密码';
        return;
    }

    try {
        const res = await axios.post(`${baseUrl}/login`, {
            username,
            password
        });
        currentUser = res.data;
        loginMsg.textContent = '登录成功！即将进入游戏';
        // 更新用户信息并跳转游戏模块
        updateUserInfo();
        setTimeout(() => {
            showModule('gameModule');
            initWebSocket(); // 登录后初始化WebSocket
        }, 1500);
    } catch (err) {
        loginMsg.textContent = err.response?.data?.error || '登录失败，请检查账号密码';
    }
}

// 3. 更新用户信息展示
async function updateUserInfo() {
    try {
        const res = await axios.get(`${baseUrl}/user`);
        currentUser = res.data;
        const userInfo = document.getElementById('userInfo');
        userInfo.innerHTML = `
            用户名：${currentUser.username} | 
            积分：${currentUser.score} | 
            胜场：${currentUser.wins} | 
            败场：${currentUser.losses}
        `;
    } catch (err) {
        alert('获取用户信息失败，请重新登录');
        showModule('loginModule');
    }
}

// 4. 退出登录
function logout() {
    // 关闭WebSocket连接
    if (ws) {
        ws.close();
        ws = null;
    }
    currentUser = null;
    battleId = null;
    showModule('loginModule');
}

// 5. 初始化WebSocket连接
function initWebSocket() {
    if (!currentUser || ws) return;

    ws = new WebSocket('ws://localhost:3000');

    // 连接建立
    ws.onopen = () => {
        console.log('WebSocket连接成功');
        // 发送身份验证
        ws.send(JSON.stringify({
            type: 'auth',
            userId: currentUser.id
        }));
    };

    // 接收消息
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleWebSocketMsg(data);
    };

    // 连接关闭
    ws.onclose = () => {
        console.log('WebSocket连接关闭');
        if (currentUser) {
            alert('连接断开，即将重新连接');
            setTimeout(initWebSocket, 3000);
        }
    };

    // 连接错误
    ws.onerror = (err) => {
        console.error('WebSocket错误：', err);
    };
}

// 6. 处理WebSocket消息
function handleWebSocketMsg(data) {
    switch (data.type) {
        case 'match_status':
            document.getElementById('matchStatus').textContent = data.message;
            break;
        case 'match_found':
            // 匹配成功，初始化对战信息
            battleId = data.battleId;
            questions = data.questions;
            document.getElementById('opponentName').textContent = data.opponent;
            showModule('battleModule');
            // 3秒倒计时后开始答题
            startCountdown();
            break;
        case 'battle_start':
            showCurrentQuestion();
            break;
        case 'battle_update':
            // 更新对手进度和得分
            if (data.playerId !== currentUser.id) {
                document.getElementById('opponentScore').textContent = data.score;
            }
            break;
        case 'battle_end':
            // 展示对战结果
            showBattleResult(data.result, data.scores);
            break;
        case 'heartbeat_ack':
            console.log('心跳响应正常');
            break;
        default:
            console.log('未知消息类型：', data.type);
    }
}

// 7. 加入匹配队列
function joinMatch() {
    if (!ws) {
        alert('连接未建立，请稍后重试');
        return;
    }

    ws.send(JSON.stringify({ type: 'match_join' }));
    document.getElementById('matchStatus').textContent = '正在寻找对手...';
    document.querySelector('button[onclick="joinMatch()"]').style.display = 'none';
    document.querySelector('button[onclick="cancelMatch()"]').style.display = 'inline';

    // 超时处理（30秒未匹配成功自动取消）
    matchTimer = setTimeout(() => {
        cancelMatch();
        document.getElementById('matchStatus').textContent = '匹配超时，请重新发起';
    }, 30000);
}

// 8. 取消匹配
function cancelMatch() {
    if (ws) {
        ws.send(JSON.stringify({ type: 'match_cancel' }));
    }
    document.getElementById('matchStatus').textContent = '已取消匹配';
    document.querySelector('button[onclick="joinMatch()"]').style.display = 'inline';
    document.querySelector('button[onclick="cancelMatch()"]').style.display = 'none';
    clearTimeout(matchTimer);
}

// 9. 对战倒计时
function startCountdown() {
    let count = 3;
    const countdownEl = document.getElementById('countdown');
    countdownEl.textContent = `对战即将开始！${count}秒`;

    const timer = setInterval(() => {
        count--;
        if (count <= 0) {
            clearInterval(timer);
            countdownEl.textContent = '对战开始！';
            // 发送对战开始通知（实际由服务端触发，这里仅做前端提示）
            ws.send(JSON.stringify({ type: 'battle_ready', battleId }));
        } else {
            countdownEl.textContent = `对战即将开始！${count}秒`;
        }
    }, 1000);
}

// 10. 展示当前题目
function showCurrentQuestion() {
    if (currentQuestionIndex >= questions.length) {
        document.getElementById('questionArea').textContent = '所有题目已答完，等待结果...';
        return;
    }

    const question = questions[currentQuestionIndex];
    const questionEl = document.getElementById('questionArea');
    const optionEl = document.getElementById('optionArea');

    // 展示题目
    questionEl.textContent = `${currentQuestionIndex + 1}. ${question.title}`;
    // 展示选项
    optionEl.innerHTML = '';
    question.options.forEach((option, index) => {
        const btn = document.createElement('button');
        btn.textContent = option;
        btn.onclick = () => submitAnswer(option);
        optionEl.appendChild(btn);
    });
}

// 11. 提交答案
function submitAnswer(answer) {
    const startTime = Date.now() - (questions[currentQuestionIndex].startTime || Date.now());
    const timeTaken = Math.floor(startTime);

    // 发送答题进度
    ws.send(JSON.stringify({
        type: 'answer_progress',
        battleId,
        questionIndex: currentQuestionIndex,
        answer,
        timeTaken
    }));

    // 验证答案正确性（前端仅做展示，最终以服务端为准）
    const question = questions[currentQuestionIndex];
    const isCorrect = answer === question.answer;
    const score = isCorrect ? (timeTaken <= 10000 ? 100 : 50) : 0;

    // 更新当前得分
    const myScoreEl = document.getElementById('myScore');
    myScoreEl.textContent = parseInt(myScoreEl.textContent) + score;

    // 进入下一题
    currentQuestionIndex++;
    setTimeout(showCurrentQuestion, 1000);
}

// 12. 展示对战结果
function showBattleResult(result, scores) {
    const resultDetail = document.getElementById('resultDetail');
    const winnerId = result.winner;
    const isWinner = winnerId === currentUser.id;

    resultDetail.innerHTML = `
        <p>${isWinner ? '恭喜你获胜！' : '很遗憾你失败了'}</p>
        <p>你的得分：${scores[currentUser.id]}</p>
        <p>对手得分：${scores[result.loser]}</p>
    `;

    // 切换模块
    showModule('resultModule');
    // 重置对战状态
    currentQuestionIndex = 0;
    battleId = null;
    questions = [];
}

// 13. 获取对战详情
async function getBattleDetail() {
    if (!battleId) {
        alert('暂无对战详情');
        return;
    }

    try {
        const res = await axios.get(`${baseUrl}/battles/${battleId}`);
        const detail = res.data;
        // 弹窗展示详情（实际项目可优化为页面展示）
        alert(`
            对战ID：${detail.id}
            开始时间：${new Date(detail.startTime).toLocaleString()}
            结束时间：${new Date(detail.endTime).toLocaleString()}
            题目数量：${detail.questions.length}
            你的答题正确率：${calcAccuracy(detail.players.find(p => p.userId === currentUser.id).answers)}
        `);
    } catch (err) {
        alert('获取对战详情失败：' + (err.response?.data?.error || '网络错误'));
    }
}

// 14. 计算答题正确率
function calcAccuracy(answers) {
    const correctCount = answers.filter(a => a.correct).length;
    return ((correctCount / answers.length) * 100).toFixed(1) + '%';
}

// 15. 获取错题本
async function getErrorBank() {
    try {
        const res = await axios.get(`${baseUrl}/error-bank`);
        const errors = res.data;
        const errorList = document.getElementById('errorList');

        if (errors.length === 0) {
            errorList.textContent = '暂无错题';
            showModule('errorBankModule');
            return;
        }

        // 渲染错题列表
        errorList.innerHTML = '';
        errors.forEach((err, index) => {
            const item = document.createElement('div');
            item.innerHTML = `
                <p>${index + 1}. 题目类型：${err.type} | 难度：${err.difficulty}</p>
                <p>你的答案：${err.userAnswer} | 正确答案：${err.correctAnswer}</p>
                <p>解析：${err.analysis}</p>
                <hr>
            `;
            errorList.appendChild(item);
        });

        showModule('errorBankModule');
    } catch (err) {
        alert('获取错题本失败：' + (err.response?.data?.error || '网络错误'));
    }
}

// 16. 维持心跳连接（30秒一次）
setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'heartbeat' }));
    }
}, 30000);