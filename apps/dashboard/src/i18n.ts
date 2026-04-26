export const LOCALES = ['ko', 'en', 'zh', 'ja'] as const;

export type Locale = (typeof LOCALES)[number];

export interface Messages {
  app: {
    loading: string;
    readOnly: string;
    title: string;
    subtitle: string;
  };
  actions: {
    close: string;
    refresh: string;
    refreshing: string;
    retry: string;
  };
  nav: {
    aria: string;
    drawerAria: string;
    drawerNavAria: string;
    menuOpen: string;
    menuClose: string;
    operations: string;
    updated: string;
    health: string;
    agents: string;
    usage: string;
    rooms: string;
    work: string;
    scheduled: string;
  };
  language: {
    label: string;
  };
  error: {
    api: string;
  };
  control: {
    aria: string;
    heartbeat: string;
    queue: string;
    governance: string;
    audit: string;
    activeRooms: string;
    pendingRooms: string;
    readOnly: string;
    writesDisabled: string;
    redacted: string;
    previewOnly: string;
  };
  metrics: {
    agents: string;
    rooms: string;
    tasks: string;
    ciWatchers: string;
    done: string;
  };
  panels: {
    health: string;
    heartbeat: string;
    usage: string;
    usageWindow: string;
    rooms: string;
    queue: string;
    scheduled: string;
    redactedPreviews: string;
  };
  service: {
    empty: string;
    heartbeat: string;
    service: string;
    rooms: string;
    updated: string;
  };
  rooms: {
    empty: string;
    cardsAria: string;
    room: string;
    service: string;
    agent: string;
    status: string;
    queue: string;
    elapsed: string;
  };
  usage: {
    empty: string;
    highest: string;
    watch: string;
    updated: string;
    peak: string;
    reset: string;
    usage: string;
    window5h: string;
    window7d: string;
    risk: {
      ok: string;
      warn: string;
      critical: string;
    };
  };
  tasks: {
    empty: string;
    cardsAria: string;
    task: string;
    status: string;
    schedule: string;
    next: string;
    last: string;
    context: string;
    ciWatch: string;
    emptyPrompt: string;
    until: string;
    lastResult: string;
  };
  status: {
    processing: string;
    waiting: string;
    inactive: string;
    active: string;
    paused: string;
    completed: string;
  };
  units: {
    second: string;
    minute: string;
    hour: string;
    task: string;
    messageShort: string;
    chars: string;
  };
}

export const languageNames: Record<Locale, string> = {
  ko: '한국어',
  en: 'English',
  zh: '简体中文',
  ja: '日本語',
};

export const localeTags: Record<Locale, string> = {
  ko: 'ko-KR',
  en: 'en-US',
  zh: 'zh-CN',
  ja: 'ja-JP',
};

export const messages = {
  ko: {
    app: {
      loading: '대시보드 로딩 중',
      readOnly: '읽기 전용',
      title: '운영',
      subtitle: '상태 · 큐 · 사용량 · 룸 · 예약',
    },
    actions: {
      close: '닫기',
      refresh: '새로고침',
      refreshing: '새로고침 중',
      retry: '다시 시도',
    },
    nav: {
      aria: '대시보드 섹션',
      drawerAria: '대시보드 메뉴',
      drawerNavAria: '대시보드 메뉴 섹션',
      menuOpen: '메뉴 열기',
      menuClose: '메뉴 닫기',
      operations: '운영',
      updated: '갱신',
      health: '상태',
      agents: '에이전트',
      usage: '사용량',
      rooms: '룸',
      work: '작업',
      scheduled: '예약',
    },
    language: {
      label: '언어',
    },
    error: {
      api: 'API 오류',
    },
    control: {
      aria: '컨트롤 플레인 요약',
      heartbeat: '에이전트 상태',
      queue: '작업 큐',
      governance: '권한',
      audit: '감사',
      activeRooms: '처리 + 대기 룸',
      pendingRooms: '메시지 대기 룸',
      readOnly: '읽기 전용',
      writesDisabled: '쓰기 작업 비활성',
      redacted: '마스킹',
      previewOnly: '120자 미리보기만',
    },
    metrics: {
      agents: '에이전트',
      rooms: '룸',
      tasks: '작업',
      ciWatchers: 'CI 감시',
      done: '완료',
    },
    panels: {
      health: '상태',
      heartbeat: '하트비트',
      usage: '사용량',
      usageWindow: '5시간 / 7일',
      rooms: '룸',
      queue: '큐',
      scheduled: '예약',
      redactedPreviews: '마스킹 미리보기',
    },
    service: {
      empty: '하트비트 없음. 서비스 로그 확인.',
      heartbeat: '하트비트',
      service: '서비스',
      rooms: '룸',
      updated: '갱신',
    },
    rooms: {
      empty: '룸 없음.',
      cardsAria: '룸 상태 카드',
      room: '룸',
      service: '서비스',
      agent: '에이전트',
      status: '상태',
      queue: '큐',
      elapsed: '경과',
    },
    usage: {
      empty: '사용량 스냅샷 없음. 수집기 확인.',
      highest: '최고',
      watch: '주의',
      updated: '갱신',
      peak: '피크',
      reset: '리셋',
      usage: '사용량',
      window5h: '5시간',
      window7d: '7일',
      risk: {
        ok: '여유',
        warn: '주의',
        critical: '위험',
      },
    },
    tasks: {
      empty: '예약 작업 없음.',
      cardsAria: '예약 작업 카드',
      task: '작업',
      status: '상태',
      schedule: '스케줄',
      next: '다음',
      last: '최근',
      context: '컨텍스트',
      ciWatch: 'CI 감시',
      emptyPrompt: '(빈 미리보기)',
      until: '까지',
      lastResult: '최근 결과',
    },
    status: {
      processing: '처리중',
      waiting: '대기',
      inactive: '휴면',
      active: '활성',
      paused: '일시정지',
      completed: '완료',
    },
    units: {
      second: '초',
      minute: '분',
      hour: '시간',
      task: '작업',
      messageShort: '메시지',
      chars: '자',
    },
  },
  en: {
    app: {
      loading: 'Loading dashboard',
      readOnly: 'read-only',
      title: 'Operations',
      subtitle: 'Health · Queue · Usage · Rooms · Scheduled',
    },
    actions: {
      close: 'Close',
      refresh: 'Refresh',
      refreshing: 'Refreshing',
      retry: 'Retry',
    },
    nav: {
      aria: 'Dashboard sections',
      drawerAria: 'Dashboard menu',
      drawerNavAria: 'Dashboard menu sections',
      menuOpen: 'Open menu',
      menuClose: 'Close menu',
      operations: 'Operations',
      updated: 'Updated',
      health: 'Health',
      agents: 'Agents',
      usage: 'Usage',
      rooms: 'Rooms',
      work: 'Work',
      scheduled: 'Scheduled',
    },
    language: {
      label: 'Language',
    },
    error: {
      api: 'API error',
    },
    control: {
      aria: 'Control plane summary',
      heartbeat: 'Agent heartbeat',
      queue: 'Work queue',
      governance: 'Governance',
      audit: 'Audit',
      activeRooms: 'processing + waiting rooms',
      pendingRooms: 'rooms with pending messages',
      readOnly: 'read only',
      writesDisabled: 'writes disabled',
      redacted: 'redacted',
      previewOnly: '120-char preview only',
    },
    metrics: {
      agents: 'agents',
      rooms: 'rooms',
      tasks: 'tasks',
      ciWatchers: 'CI watchers',
      done: 'done',
    },
    panels: {
      health: 'Health',
      heartbeat: 'Heartbeat',
      usage: 'Usage',
      usageWindow: '5h / 7d',
      rooms: 'Rooms',
      queue: 'Queue',
      scheduled: 'Scheduled',
      redactedPreviews: 'Redacted previews',
    },
    service: {
      empty: 'No heartbeat yet. Check service logs.',
      heartbeat: 'heartbeat',
      service: 'service',
      rooms: 'rooms',
      updated: 'updated',
    },
    rooms: {
      empty: 'No rooms yet.',
      cardsAria: 'Room status cards',
      room: 'room',
      service: 'service',
      agent: 'agent',
      status: 'status',
      queue: 'queue',
      elapsed: 'elapsed',
    },
    usage: {
      empty: 'No usage snapshot. Check collector.',
      highest: 'Highest',
      watch: 'Watch',
      updated: 'Updated',
      peak: 'Peak',
      reset: 'reset',
      usage: 'usage',
      window5h: '5h',
      window7d: '7d',
      risk: {
        ok: 'Clear',
        warn: 'Watch',
        critical: 'Limit risk',
      },
    },
    tasks: {
      empty: 'No scheduled work.',
      cardsAria: 'Scheduled task cards',
      task: 'task',
      status: 'status',
      schedule: 'schedule',
      next: 'next',
      last: 'last',
      context: 'context',
      ciWatch: 'CI Watch',
      emptyPrompt: '(empty preview)',
      until: 'until',
      lastResult: 'last result',
    },
    status: {
      processing: 'processing',
      waiting: 'waiting',
      inactive: 'inactive',
      active: 'active',
      paused: 'paused',
      completed: 'completed',
    },
    units: {
      second: 's',
      minute: 'm',
      hour: 'h',
      task: 'task',
      messageShort: 'msg',
      chars: 'chars',
    },
  },
  zh: {
    app: {
      loading: '正在加载仪表盘',
      readOnly: '只读',
      title: '运营',
      subtitle: '健康 · 队列 · 用量 · 房间 · 计划',
    },
    actions: {
      close: '关闭',
      refresh: '刷新',
      refreshing: '刷新中',
      retry: '重试',
    },
    nav: {
      aria: '仪表盘分区',
      drawerAria: '仪表盘菜单',
      drawerNavAria: '仪表盘菜单分区',
      menuOpen: '打开菜单',
      menuClose: '关闭菜单',
      operations: '运营',
      updated: '更新',
      health: '健康',
      agents: '代理',
      usage: '用量',
      rooms: '房间',
      work: '任务',
      scheduled: '计划',
    },
    language: {
      label: '语言',
    },
    error: {
      api: 'API 错误',
    },
    control: {
      aria: '控制平面摘要',
      heartbeat: '代理心跳',
      queue: '任务队列',
      governance: '治理',
      audit: '审计',
      activeRooms: '处理中 + 等待房间',
      pendingRooms: '有待处理消息的房间',
      readOnly: '只读',
      writesDisabled: '写入已禁用',
      redacted: '已脱敏',
      previewOnly: '仅 120 字预览',
    },
    metrics: {
      agents: '代理',
      rooms: '房间',
      tasks: '任务',
      ciWatchers: 'CI 监控',
      done: '完成',
    },
    panels: {
      health: '健康',
      heartbeat: '心跳',
      usage: '用量',
      usageWindow: '5小时 / 7天',
      rooms: '房间',
      queue: '队列',
      scheduled: '计划',
      redactedPreviews: '脱敏预览',
    },
    service: {
      empty: '暂无心跳。检查服务日志。',
      heartbeat: '心跳',
      service: '服务',
      rooms: '房间',
      updated: '更新',
    },
    rooms: {
      empty: '暂无房间。',
      cardsAria: '房间状态卡片',
      room: '房间',
      service: '服务',
      agent: '代理',
      status: '状态',
      queue: '队列',
      elapsed: '耗时',
    },
    usage: {
      empty: '暂无用量快照。检查采集器。',
      highest: '最高',
      watch: '关注',
      updated: '更新',
      peak: '峰值',
      reset: '重置',
      usage: '用量',
      window5h: '5小时',
      window7d: '7天',
      risk: {
        ok: '充足',
        warn: '关注',
        critical: '接近上限',
      },
    },
    tasks: {
      empty: '暂无计划任务。',
      cardsAria: '计划任务卡片',
      task: '任务',
      status: '状态',
      schedule: '计划',
      next: '下次',
      last: '最近',
      context: '上下文',
      ciWatch: 'CI 监控',
      emptyPrompt: '（空预览）',
      until: '直到',
      lastResult: '最近结果',
    },
    status: {
      processing: '处理中',
      waiting: '等待',
      inactive: '空闲',
      active: '活跃',
      paused: '暂停',
      completed: '完成',
    },
    units: {
      second: '秒',
      minute: '分',
      hour: '小时',
      task: '任务',
      messageShort: '消息',
      chars: '字',
    },
  },
  ja: {
    app: {
      loading: 'ダッシュボードを読み込み中',
      readOnly: '読み取り専用',
      title: '運用',
      subtitle: '状態 · キュー · 使用量 · ルーム · 予定',
    },
    actions: {
      close: '閉じる',
      refresh: '更新',
      refreshing: '更新中',
      retry: '再試行',
    },
    nav: {
      aria: 'ダッシュボードセクション',
      drawerAria: 'ダッシュボードメニュー',
      drawerNavAria: 'ダッシュボードメニューセクション',
      menuOpen: 'メニューを開く',
      menuClose: 'メニューを閉じる',
      operations: '運用',
      updated: '更新',
      health: '状態',
      agents: 'エージェント',
      usage: '使用量',
      rooms: 'ルーム',
      work: '作業',
      scheduled: '予定',
    },
    language: {
      label: '言語',
    },
    error: {
      api: 'API エラー',
    },
    control: {
      aria: 'コントロールプレーン概要',
      heartbeat: 'エージェント状態',
      queue: '作業キュー',
      governance: '権限',
      audit: '監査',
      activeRooms: '処理中 + 待機ルーム',
      pendingRooms: 'メッセージ待ちルーム',
      readOnly: '読み取り専用',
      writesDisabled: '書き込み無効',
      redacted: 'マスク済み',
      previewOnly: '120字プレビューのみ',
    },
    metrics: {
      agents: 'エージェント',
      rooms: 'ルーム',
      tasks: '作業',
      ciWatchers: 'CI監視',
      done: '完了',
    },
    panels: {
      health: '状態',
      heartbeat: 'ハートビート',
      usage: '使用量',
      usageWindow: '5時間 / 7日',
      rooms: 'ルーム',
      queue: 'キュー',
      scheduled: '予定',
      redactedPreviews: 'マスク済みプレビュー',
    },
    service: {
      empty: 'ハートビートなし。サービスログを確認。',
      heartbeat: 'ハートビート',
      service: 'サービス',
      rooms: 'ルーム',
      updated: '更新',
    },
    rooms: {
      empty: 'ルームなし。',
      cardsAria: 'ルーム状態カード',
      room: 'ルーム',
      service: 'サービス',
      agent: 'エージェント',
      status: '状態',
      queue: 'キュー',
      elapsed: '経過',
    },
    usage: {
      empty: '使用量スナップショットなし。収集器を確認。',
      highest: '最高',
      watch: '注意',
      updated: '更新',
      peak: 'ピーク',
      reset: 'リセット',
      usage: '使用量',
      window5h: '5時間',
      window7d: '7日',
      risk: {
        ok: '余裕',
        warn: '注意',
        critical: '上限注意',
      },
    },
    tasks: {
      empty: '予定作業なし。',
      cardsAria: '予定作業カード',
      task: '作業',
      status: '状態',
      schedule: '予定',
      next: '次回',
      last: '直近',
      context: 'コンテキスト',
      ciWatch: 'CI監視',
      emptyPrompt: '（空のプレビュー）',
      until: 'まで',
      lastResult: '直近結果',
    },
    status: {
      processing: '処理中',
      waiting: '待機',
      inactive: '休止',
      active: '有効',
      paused: '一時停止',
      completed: '完了',
    },
    units: {
      second: '秒',
      minute: '分',
      hour: '時間',
      task: '作業',
      messageShort: 'メッセージ',
      chars: '字',
    },
  },
} satisfies Record<Locale, Messages>;

export function isLocale(value: string | null | undefined): value is Locale {
  return LOCALES.includes(value as Locale);
}

export function matchLocale(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized.startsWith('ko')) return 'ko';
  if (normalized.startsWith('en')) return 'en';
  if (normalized.startsWith('zh')) return 'zh';
  if (normalized.startsWith('ja')) return 'ja';
  return null;
}
