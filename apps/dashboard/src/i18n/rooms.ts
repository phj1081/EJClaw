import type { Locale } from '../i18n';

export interface RoomMessages {
  empty: string;
  cardsAria: string;
  room: string;
  service: string;
  agent: string;
  status: string;
  queue: string;
  queueWaitingMessages: string;
  tasks: string;
  elapsed: string;
  activity: string;
  loadingActivity: string;
  noActivity: string;
  task: string;
  noTask: string;
  currentTurn: string;
  noTurn: string;
  round: string;
  attempt: string;
  updated: string;
  output: string;
  latestOutput: string;
  outputHistory: string;
  noOutput: string;
  recentMessages: string;
  messageHistory: string;
  noMessages: string;
  details: string;
  message: string;
  messagePlaceholder: string;
  send: string;
  sending: string;
  error: string;
  filterAll: string;
  sortRecent: string;
  sortName: string;
  sortQueue: string;
  sortLabel: string;
}

export const roomMessages = {
  ko: {
    empty: '룸 없음.',
    cardsAria: '룸 상태 카드',
    room: '룸',
    service: '서비스',
    agent: '에이전트',
    status: '상태',
    queue: '큐',
    queueWaitingMessages: '대기 메시지',
    tasks: '태스크',
    elapsed: '경과',
    activity: '진행',
    loadingActivity: '진행 로딩 중',
    noActivity: '진행 없음',
    task: '태스크',
    noTask: '태스크 없음',
    currentTurn: '현재 턴',
    noTurn: '턴 없음',
    round: '라운드',
    attempt: '시도',
    updated: '갱신',
    output: '출력',
    latestOutput: '마지막 출력',
    outputHistory: '출력 기록',
    noOutput: '출력 없음',
    recentMessages: '메시지 기록',
    messageHistory: '메시지 기록',
    noMessages: '메시지 없음',
    details: '세부',
    message: '메시지',
    messagePlaceholder: '요청 입력...',
    send: '전송',
    sending: '전송 중...',
    error: '오류',
    filterAll: '전체',
    sortRecent: '최근 활동',
    sortName: '이름순',
    sortQueue: '큐 많은 순',
    sortLabel: '정렬',
  },
  en: {
    empty: 'No rooms yet.',
    cardsAria: 'Room status cards',
    room: 'room',
    service: 'service',
    agent: 'agent',
    status: 'status',
    queue: 'queue',
    queueWaitingMessages: 'pending messages',
    tasks: 'tasks',
    elapsed: 'elapsed',
    activity: 'activity',
    loadingActivity: 'Loading activity',
    noActivity: 'No activity',
    task: 'task',
    noTask: 'No task',
    currentTurn: 'Current turn',
    noTurn: 'No turn',
    round: 'round',
    attempt: 'attempt',
    updated: 'updated',
    output: 'output',
    latestOutput: 'latest output',
    outputHistory: 'output log',
    noOutput: 'No output',
    recentMessages: 'Message log',
    messageHistory: 'Message log',
    noMessages: 'No messages',
    details: 'details',
    message: 'message',
    messagePlaceholder: 'Type request...',
    send: 'Send',
    sending: 'Sending',
    error: 'Error',
    filterAll: 'All',
    sortRecent: 'Recent activity',
    sortName: 'Name',
    sortQueue: 'Queue size',
    sortLabel: 'Sort',
  },
  zh: {
    empty: '暂无房间。',
    cardsAria: '房间状态卡片',
    room: '房间',
    service: '服务',
    agent: '代理',
    status: '状态',
    queue: '队列',
    queueWaitingMessages: '待处理消息',
    tasks: '任务',
    elapsed: '耗时',
    activity: '进展',
    loadingActivity: '正在加载进展',
    noActivity: '暂无进展',
    task: '任务',
    noTask: '无任务',
    currentTurn: '当前回合',
    noTurn: '无回合',
    round: '轮次',
    attempt: '尝试',
    updated: '更新',
    output: '输出',
    latestOutput: '最新输出',
    outputHistory: '输出记录',
    noOutput: '暂无输出',
    recentMessages: '消息记录',
    messageHistory: '消息记录',
    noMessages: '暂无消息',
    details: '详情',
    message: 'Message',
    messagePlaceholder: '输入请求...',
    send: '发送',
    sending: '发送中...',
    error: '错误',
    filterAll: '全部',
    sortRecent: '最近活动',
    sortName: '名称',
    sortQueue: '队列大小',
    sortLabel: '排序',
  },
  ja: {
    empty: 'ルームなし。',
    cardsAria: 'ルーム状態カード',
    room: 'ルーム',
    service: 'サービス',
    agent: 'エージェント',
    status: '状態',
    queue: 'キュー',
    queueWaitingMessages: '待機メッセージ',
    tasks: 'タスク',
    elapsed: '経過',
    activity: '進行',
    loadingActivity: '進行を読み込み中',
    noActivity: '進行なし',
    task: 'タスク',
    noTask: 'タスクなし',
    currentTurn: '現在ターン',
    noTurn: 'ターンなし',
    round: 'ラウンド',
    attempt: '試行',
    updated: '更新',
    output: '出力',
    latestOutput: '最新出力',
    outputHistory: '出力履歴',
    noOutput: '出力なし',
    recentMessages: 'メッセージ履歴',
    messageHistory: 'メッセージ履歴',
    noMessages: 'メッセージなし',
    details: '詳細',
    message: 'メッセージ',
    messagePlaceholder: '依頼を入力...',
    send: '送信',
    sending: '送信中...',
    error: 'エラー',
    filterAll: '全て',
    sortRecent: '最近の活動',
    sortName: '名前順',
    sortQueue: 'キュー順',
    sortLabel: '並び替え',
  },
} satisfies Record<Locale, RoomMessages>;
