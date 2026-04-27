export const LOCALES = ['ko', 'en', 'zh', 'ja'] as const;

export type Locale = (typeof LOCALES)[number];

export interface Messages {
  app: {
    loading: string;
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
    inbox: string;
    usage: string;
    rooms: string;
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
    queue: string;
    activeRooms: string;
    pendingRooms: string;
  };
  pwa: {
    app: string;
    install: string;
    installed: string;
    ready: string;
    cached: string;
    online: string;
    offline: string;
    fresh: string;
    stale: string;
    secureRequired: string;
    updated: string;
  };
  metrics: {
    agents: string;
    rooms: string;
    ciWatchers: string;
  };
  panels: {
    health: string;
    heartbeat: string;
    healthSignals: string;
    inbox: string;
    inboxQueue: string;
    usage: string;
    usageWindow: string;
    rooms: string;
    queue: string;
    scheduled: string;
    promptPreviews: string;
  };
  service: {
    empty: string;
    heartbeat: string;
    service: string;
    rooms: string;
    updated: string;
  };
  health: {
    system: string;
    signals: string;
    services: string;
    fresh: string;
    stale: string;
    queue: string;
    ciFailures: string;
    affectedServices: string;
    restart: string;
    restartStack: string;
    restarting: string;
    restartHint: string;
    confirmRestart: string;
    restartLog: string;
    restartTarget: string;
    restartStatus: string;
    restartRequested: string;
    restartServices: string;
    levels: {
      ok: string;
      stale: string;
      down: string;
    };
  };
  inbox: {
    empty: string;
    cardsAria: string;
    summary: string;
    total: string;
    filters: string;
    all: string;
    noSummary: string;
    occurred: string;
    source: string;
    target: string;
    openTask: string;
    openRoom: string;
    kinds: {
      'pending-room': string;
      'reviewer-request': string;
      approval: string;
      'arbiter-request': string;
      'ci-failure': string;
      mention: string;
    };
    severity: {
      info: string;
      warn: string;
      error: string;
    };
    actions: {
      run: string;
      busy: string;
      runReview: string;
      finalize: string;
      runArbiter: string;
      decline: string;
      dismiss: string;
      confirmDecline: string;
    };
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
    details: string;
    message: string;
    messagePlaceholder: string;
    send: string;
    sending: string;
  };
  usage: {
    empty: string;
    current: string;
    tightest: string;
    watch: string;
    remaining: string;
    speed: string;
    inUse: string;
    reset: string;
    noReset: string;
    limitBasis: {
      h5: string;
      d7: string;
    };
    quota: {
      h5: string;
      d7: string;
    };
    usage: string;
    groupPrimary: string;
    groupCodex: string;
    risk: {
      ok: string;
      warn: string;
      critical: string;
    };
    speedLabel: {
      ok: string;
      warn: string;
      critical: string;
    };
  };
  tasks: {
    empty: string;
    cardsAria: string;
    groups: {
      watchers: string;
      scheduled: string;
      paused: string;
      completed: string;
    };
    count: string;
    groupEmpty: string;
    task: string;
    status: string;
    schedule: string;
    next: string;
    last: string;
    context: string;
    ciWatch: string;
    emptyPrompt: string;
    prompt: string;
    until: string;
    suspendedUntil: string;
    lastResult: string;
    result: string;
    resultOk: string;
    resultFail: string;
    noResult: string;
    noTime: string;
    now: string;
    createTitle: string;
    createSubtitle: string;
    room: string;
    selectRoom: string;
    scheduleType: string;
    scheduleValue: string;
    scheduleValueHint: string;
    promptPlaceholder: string;
    editPromptPlaceholder: string;
    scheduleTypes: {
      once: string;
      interval: string;
      cron: string;
    };
    contextModes: {
      isolated: string;
      group: string;
    };
    actions: {
      create: string;
      edit: string;
      save: string;
      pause: string;
      resume: string;
      cancel: string;
      busy: string;
      confirmCancel: string;
    };
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
      inbox: 'Inbox',
      usage: '사용량',
      rooms: '룸',
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
      queue: '작업 큐',
      activeRooms: '처리 + 대기 룸',
      pendingRooms: '메시지 대기 룸',
    },
    pwa: {
      app: 'PWA',
      install: '설치',
      installed: '설치됨',
      ready: '오프라인 준비',
      cached: '캐시됨',
      online: '온라인',
      offline: '오프라인',
      fresh: '최신',
      stale: '지연',
      secureRequired: 'HTTPS 필요',
      updated: '갱신',
    },
    metrics: {
      agents: '에이전트',
      rooms: '룸',
      ciWatchers: 'CI 감시',
    },
    panels: {
      health: '상태',
      heartbeat: '하트비트',
      healthSignals: '운영 신호',
      inbox: 'Inbox',
      inboxQueue: 'Queue',
      usage: '사용량',
      usageWindow: '남음 / 속도',
      rooms: '룸',
      queue: '큐',
      scheduled: '예약',
      promptPreviews: '프롬프트 미리보기',
    },
    service: {
      empty: '하트비트 없음. 서비스 로그 확인.',
      heartbeat: '하트비트',
      service: '서비스',
      rooms: '룸',
      updated: '갱신',
    },
    health: {
      system: '시스템',
      signals: '헬스 신호',
      services: '서비스',
      fresh: '정상',
      stale: '지연',
      queue: '큐',
      ciFailures: 'CI 실패',
      affectedServices: '이상 서비스',
      restart: 'Restart',
      restartStack: 'Restart stack',
      restarting: 'Restarting...',
      restartHint: '서비스 전체 재시작',
      confirmRestart: 'Restart stack now?',
      restartLog: 'Restart log',
      restartTarget: 'Target',
      restartStatus: 'Status',
      restartRequested: 'Requested',
      restartServices: 'Services',
      levels: {
        ok: '정상',
        stale: '주의',
        down: '중단',
      },
    },
    inbox: {
      empty: 'Inbox 없음.',
      cardsAria: 'Inbox 항목',
      summary: 'Inbox 요약',
      total: '전체',
      filters: 'Inbox 필터',
      all: '전체',
      noSummary: '요약 없음',
      occurred: '발생',
      source: '소스',
      target: '대상',
      openTask: '예약 보기',
      openRoom: '룸 보기',
      kinds: {
        'pending-room': '대기 룸',
        'reviewer-request': '리뷰 요청',
        approval: '승인',
        'arbiter-request': '중재 요청',
        'ci-failure': 'CI 실패',
        mention: '멘션',
      },
      severity: {
        info: '정보',
        warn: '주의',
        error: '위험',
      },
      actions: {
        run: 'Run',
        busy: 'Running...',
        runReview: 'Run review',
        finalize: 'Finalize',
        runArbiter: 'Run arbiter',
        decline: 'Decline',
        dismiss: 'Dismiss',
        confirmDecline: 'Decline this item?',
      },
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
      details: '세부',
      message: 'Message',
      messagePlaceholder: 'Type request...',
      send: 'Send',
      sending: 'Sending',
    },
    usage: {
      empty: '사용량 스냅샷 없음. 수집기 확인.',
      current: '사용중',
      tightest: '가장 적음',
      watch: '주의',
      remaining: '남음',
      speed: '속도',
      inUse: '사용중',
      reset: '리셋',
      noReset: '리셋 없음',
      limitBasis: {
        h5: '5시간 기준',
        d7: '7일 기준',
      },
      quota: {
        h5: '5시간',
        d7: '7일',
      },
      usage: '사용량',
      groupPrimary: 'Claude / Kimi',
      groupCodex: 'Codex',
      risk: {
        ok: '여유',
        warn: '주의',
        critical: '위험',
      },
      speedLabel: {
        ok: '보통',
        warn: '빠름',
        critical: '너무 빠름',
      },
    },
    tasks: {
      empty: '예약 작업 없음.',
      cardsAria: '예약 작업 카드',
      groups: {
        watchers: 'CI 감시',
        scheduled: '예약',
        paused: '일시정지',
        completed: '완료',
      },
      count: '개',
      groupEmpty: '해당 없음',
      task: '작업',
      status: '상태',
      schedule: '스케줄',
      next: '다음',
      last: '최근',
      context: '컨텍스트',
      ciWatch: 'CI 감시',
      emptyPrompt: '(빈 미리보기)',
      prompt: '프롬프트',
      until: '까지',
      suspendedUntil: '정지 해제',
      lastResult: '최근 결과',
      result: '결과 없음',
      resultOk: '정상',
      resultFail: '실패',
      noResult: '결과 없음',
      noTime: '-',
      now: '지금',
      createTitle: 'Create task',
      createSubtitle: 'Schedule work from web',
      room: 'Room',
      selectRoom: 'Select room',
      scheduleType: 'Type',
      scheduleValue: 'Value',
      scheduleValueHint: 'ISO time, ms, or cron',
      promptPlaceholder: 'What should the agent do?',
      editPromptPlaceholder: 'Leave blank to keep prompt',
      scheduleTypes: {
        once: 'Once',
        interval: 'Interval',
        cron: 'Cron',
      },
      contextModes: {
        isolated: 'Isolated',
        group: 'Group',
      },
      actions: {
        create: 'Create',
        edit: 'Edit',
        save: 'Save',
        pause: 'Pause',
        resume: 'Resume',
        cancel: 'Cancel',
        busy: 'Working',
        confirmCancel: 'Cancel this scheduled work?',
      },
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
      operations: 'Ops',
      updated: 'Updated',
      health: 'Health',
      inbox: 'Inbox',
      usage: 'Usage',
      rooms: 'Rooms',
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
      queue: 'Work queue',
      activeRooms: 'processing + waiting rooms',
      pendingRooms: 'rooms with pending messages',
    },
    pwa: {
      app: 'PWA',
      install: 'Install',
      installed: 'Installed',
      ready: 'Offline ready',
      cached: 'Cached',
      online: 'Online',
      offline: 'Offline',
      fresh: 'Fresh',
      stale: 'Stale',
      secureRequired: 'HTTPS required',
      updated: 'Updated',
    },
    metrics: {
      agents: 'agents',
      rooms: 'rooms',
      ciWatchers: 'CI watchers',
    },
    panels: {
      health: 'Health',
      heartbeat: 'Heartbeat',
      healthSignals: 'Signals',
      inbox: 'Inbox',
      inboxQueue: 'Queue',
      usage: 'Usage',
      usageWindow: 'Remaining / speed',
      rooms: 'Rooms',
      queue: 'Queue',
      scheduled: 'Scheduled',
      promptPreviews: 'Prompt previews',
    },
    service: {
      empty: 'No heartbeat yet. Check service logs.',
      heartbeat: 'heartbeat',
      service: 'service',
      rooms: 'rooms',
      updated: 'updated',
    },
    health: {
      system: 'System',
      signals: 'Health signals',
      services: 'Services',
      fresh: 'Fresh',
      stale: 'stale',
      queue: 'Queue',
      ciFailures: 'CI failures',
      affectedServices: 'Affected services',
      restart: 'Restart',
      restartStack: 'Restart stack',
      restarting: 'Restarting...',
      restartHint: 'Restart all services',
      confirmRestart: 'Restart stack now?',
      restartLog: 'Restart log',
      restartTarget: 'Target',
      restartStatus: 'Status',
      restartRequested: 'Requested',
      restartServices: 'Services',
      levels: {
        ok: 'OK',
        stale: 'Watch',
        down: 'Down',
      },
    },
    inbox: {
      empty: 'No queued work.',
      cardsAria: 'Inbox items',
      summary: 'Inbox summary',
      total: 'Total',
      filters: 'Inbox filters',
      all: 'All',
      noSummary: 'No summary',
      occurred: 'Occurred',
      source: 'Source',
      target: 'Target',
      openTask: 'Open scheduled',
      openRoom: 'Open room',
      kinds: {
        'pending-room': 'Pending room',
        'reviewer-request': 'Review request',
        approval: 'Approval',
        'arbiter-request': 'Arbiter request',
        'ci-failure': 'CI failure',
        mention: 'Mention',
      },
      severity: {
        info: 'Info',
        warn: 'Warn',
        error: 'Risk',
      },
      actions: {
        run: 'Run',
        busy: 'Running...',
        runReview: 'Run review',
        finalize: 'Finalize',
        runArbiter: 'Run arbiter',
        decline: 'Decline',
        dismiss: 'Dismiss',
        confirmDecline: 'Decline this item?',
      },
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
      details: 'details',
      message: 'message',
      messagePlaceholder: 'Type request...',
      send: 'Send',
      sending: 'Sending',
    },
    usage: {
      empty: 'No usage snapshot. Check collector.',
      current: 'Active',
      tightest: 'Tightest',
      watch: 'Watch',
      remaining: 'Left',
      speed: 'Rate',
      inUse: 'active',
      reset: 'reset',
      noReset: 'no reset',
      limitBasis: {
        h5: '5h basis',
        d7: '7d basis',
      },
      quota: {
        h5: '5h',
        d7: '7d',
      },
      usage: 'usage',
      groupPrimary: 'Claude / Kimi',
      groupCodex: 'Codex',
      risk: {
        ok: 'OK',
        warn: 'Watch',
        critical: 'Risk',
      },
      speedLabel: {
        ok: 'OK',
        warn: 'Fast',
        critical: 'Too fast',
      },
    },
    tasks: {
      empty: 'No scheduled work.',
      cardsAria: 'Scheduled task cards',
      groups: {
        watchers: 'CI watch',
        scheduled: 'Scheduled',
        paused: 'Paused',
        completed: 'Completed',
      },
      count: 'items',
      groupEmpty: 'None',
      task: 'task',
      status: 'status',
      schedule: 'schedule',
      next: 'next',
      last: 'last',
      context: 'context',
      ciWatch: 'CI Watch',
      emptyPrompt: '(empty preview)',
      prompt: 'prompt',
      until: 'until',
      suspendedUntil: 'resume',
      lastResult: 'last result',
      result: 'no result',
      resultOk: 'ok',
      resultFail: 'failed',
      noResult: 'no result',
      noTime: '-',
      now: 'now',
      createTitle: 'Create task',
      createSubtitle: 'Schedule work from web',
      room: 'Room',
      selectRoom: 'Select room',
      scheduleType: 'Type',
      scheduleValue: 'Value',
      scheduleValueHint: 'ISO time, ms, or cron',
      promptPlaceholder: 'What should the agent do?',
      editPromptPlaceholder: 'Leave blank to keep prompt',
      scheduleTypes: {
        once: 'Once',
        interval: 'Interval',
        cron: 'Cron',
      },
      contextModes: {
        isolated: 'Isolated',
        group: 'Group',
      },
      actions: {
        create: 'Create',
        edit: 'Edit',
        save: 'Save',
        pause: 'Pause',
        resume: 'Resume',
        cancel: 'Cancel',
        busy: 'Working',
        confirmCancel: 'Cancel this scheduled work?',
      },
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
      inbox: '收件',
      usage: '用量',
      rooms: '房间',
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
      queue: '任务队列',
      activeRooms: '处理中 + 等待房间',
      pendingRooms: '有待处理消息的房间',
    },
    pwa: {
      app: 'PWA',
      install: '安装',
      installed: '已安装',
      ready: '离线可用',
      cached: '已缓存',
      online: '在线',
      offline: '离线',
      fresh: '最新',
      stale: '延迟',
      secureRequired: '需要 HTTPS',
      updated: '更新',
    },
    metrics: {
      agents: '代理',
      rooms: '房间',
      ciWatchers: 'CI 监控',
    },
    panels: {
      health: '健康',
      heartbeat: '心跳',
      healthSignals: '运行信号',
      inbox: '收件',
      inboxQueue: '待处理',
      usage: '用量',
      usageWindow: '剩余 / 速度',
      rooms: '房间',
      queue: '队列',
      scheduled: '计划',
      promptPreviews: '提示预览',
    },
    service: {
      empty: '暂无心跳。检查服务日志。',
      heartbeat: '心跳',
      service: '服务',
      rooms: '房间',
      updated: '更新',
    },
    health: {
      system: '系统',
      signals: '健康信号',
      services: '服务',
      fresh: '正常',
      stale: '延迟',
      queue: '队列',
      ciFailures: 'CI 失败',
      affectedServices: '异常服务',
      restart: '重启',
      restartStack: '重启 stack',
      restarting: '重启中...',
      restartHint: '重启全部服务',
      confirmRestart: '现在重启 stack?',
      restartLog: '重启记录',
      restartTarget: '目标',
      restartStatus: '状态',
      restartRequested: '请求',
      restartServices: '服务',
      levels: {
        ok: '正常',
        stale: '关注',
        down: '中断',
      },
    },
    inbox: {
      empty: '暂无收件。',
      cardsAria: '收件项',
      summary: '收件摘要',
      total: '全部',
      filters: '收件筛选',
      all: '全部',
      noSummary: '无摘要',
      occurred: '发生',
      source: '来源',
      target: '目标',
      openTask: '查看计划',
      openRoom: '查看房间',
      kinds: {
        'pending-room': '待处理房间',
        'reviewer-request': '评审请求',
        approval: '审批',
        'arbiter-request': '仲裁请求',
        'ci-failure': 'CI 失败',
        mention: '提及',
      },
      severity: {
        info: '信息',
        warn: '关注',
        error: '风险',
      },
      actions: {
        run: '运行',
        busy: '运行中...',
        runReview: '运行评审',
        finalize: '完成',
        runArbiter: '运行仲裁',
        decline: '拒绝',
        dismiss: '忽略',
        confirmDecline: '确认拒绝此项？',
      },
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
      details: '详情',
      message: 'Message',
      messagePlaceholder: 'Type request...',
      send: 'Send',
      sending: 'Sending',
    },
    usage: {
      empty: '暂无用量快照。检查采集器。',
      current: '使用中',
      tightest: '剩余最少',
      watch: '关注',
      remaining: '剩余',
      speed: '速度',
      inUse: '使用中',
      reset: '重置',
      noReset: '无重置',
      limitBasis: {
        h5: '按5小时',
        d7: '按7天',
      },
      quota: {
        h5: '5小时',
        d7: '7天',
      },
      usage: '用量',
      groupPrimary: 'Claude / Kimi',
      groupCodex: 'Codex',
      risk: {
        ok: '充足',
        warn: '关注',
        critical: '接近上限',
      },
      speedLabel: {
        ok: '正常',
        warn: '较快',
        critical: '过快',
      },
    },
    tasks: {
      empty: '暂无计划任务。',
      cardsAria: '计划任务卡片',
      groups: {
        watchers: 'CI 监控',
        scheduled: '计划',
        paused: '暂停',
        completed: '完成',
      },
      count: '项',
      groupEmpty: '无',
      task: '任务',
      status: '状态',
      schedule: '计划',
      next: '下次',
      last: '最近',
      context: '上下文',
      ciWatch: 'CI 监控',
      emptyPrompt: '（空预览）',
      prompt: '提示',
      until: '直到',
      suspendedUntil: '恢复',
      lastResult: '最近结果',
      result: '无结果',
      resultOk: '正常',
      resultFail: '失败',
      noResult: '无结果',
      noTime: '-',
      now: '现在',
      createTitle: 'Create task',
      createSubtitle: 'Schedule work from web',
      room: 'Room',
      selectRoom: 'Select room',
      scheduleType: 'Type',
      scheduleValue: 'Value',
      scheduleValueHint: 'ISO time, ms, or cron',
      promptPlaceholder: 'What should the agent do?',
      editPromptPlaceholder: 'Leave blank to keep prompt',
      scheduleTypes: {
        once: 'Once',
        interval: 'Interval',
        cron: 'Cron',
      },
      contextModes: {
        isolated: 'Isolated',
        group: 'Group',
      },
      actions: {
        create: 'Create',
        edit: 'Edit',
        save: 'Save',
        pause: 'Pause',
        resume: 'Resume',
        cancel: 'Cancel',
        busy: 'Working',
        confirmCancel: 'Cancel this scheduled work?',
      },
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
      inbox: '受信',
      usage: '使用量',
      rooms: 'ルーム',
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
      queue: '作業キュー',
      activeRooms: '処理中 + 待機ルーム',
      pendingRooms: 'メッセージ待ちルーム',
    },
    pwa: {
      app: 'PWA',
      install: 'インストール',
      installed: 'インストール済み',
      ready: 'オフライン可',
      cached: 'キャッシュ済み',
      online: 'オンライン',
      offline: 'オフライン',
      fresh: '最新',
      stale: '遅延',
      secureRequired: 'HTTPS 必須',
      updated: '更新',
    },
    metrics: {
      agents: 'エージェント',
      rooms: 'ルーム',
      ciWatchers: 'CI監視',
    },
    panels: {
      health: '状態',
      heartbeat: 'ハートビート',
      healthSignals: '運用シグナル',
      inbox: '受信',
      inboxQueue: '対応待ち',
      usage: '使用量',
      usageWindow: '残量 / 速度',
      rooms: 'ルーム',
      queue: 'キュー',
      scheduled: '予定',
      promptPreviews: 'プロンプトプレビュー',
    },
    service: {
      empty: 'ハートビートなし。サービスログを確認。',
      heartbeat: 'ハートビート',
      service: 'サービス',
      rooms: 'ルーム',
      updated: '更新',
    },
    health: {
      system: 'システム',
      signals: '状態シグナル',
      services: 'サービス',
      fresh: '正常',
      stale: '遅延',
      queue: 'キュー',
      ciFailures: 'CI失敗',
      affectedServices: '異常サービス',
      restart: '再起動',
      restartStack: 'Stack再起動',
      restarting: '再起動中...',
      restartHint: '全サービス再起動',
      confirmRestart: 'Stackを再起動しますか?',
      restartLog: '再起動ログ',
      restartTarget: '対象',
      restartStatus: '状態',
      restartRequested: '要求',
      restartServices: 'サービス',
      levels: {
        ok: '正常',
        stale: '注意',
        down: '停止',
      },
    },
    inbox: {
      empty: '受信なし。',
      cardsAria: '受信項目',
      summary: '受信サマリー',
      total: '全体',
      filters: '受信フィルター',
      all: '全体',
      noSummary: '概要なし',
      occurred: '発生',
      source: 'ソース',
      target: '対象',
      openTask: '予定を見る',
      openRoom: 'ルームを見る',
      kinds: {
        'pending-room': '待機ルーム',
        'reviewer-request': 'レビュー依頼',
        approval: '承認',
        'arbiter-request': '仲裁依頼',
        'ci-failure': 'CI失敗',
        mention: 'メンション',
      },
      severity: {
        info: '情報',
        warn: '注意',
        error: '危険',
      },
      actions: {
        run: '実行',
        busy: '実行中...',
        runReview: 'レビュー実行',
        finalize: 'Finalize',
        runArbiter: '仲裁実行',
        decline: '拒否',
        dismiss: '非表示',
        confirmDecline: 'この項目を拒否しますか？',
      },
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
      details: '詳細',
      message: 'Message',
      messagePlaceholder: 'Type request...',
      send: 'Send',
      sending: 'Sending',
    },
    usage: {
      empty: '使用量スナップショットなし。収集器を確認。',
      current: '使用中',
      tightest: '残量最少',
      watch: '注意',
      remaining: '残量',
      speed: '速度',
      inUse: '使用中',
      reset: 'リセット',
      noReset: 'リセットなし',
      limitBasis: {
        h5: '5時間基準',
        d7: '7日基準',
      },
      quota: {
        h5: '5時間',
        d7: '7日',
      },
      usage: '使用量',
      groupPrimary: 'Claude / Kimi',
      groupCodex: 'Codex',
      risk: {
        ok: '余裕',
        warn: '注意',
        critical: '上限注意',
      },
      speedLabel: {
        ok: '通常',
        warn: '速い',
        critical: '速すぎ',
      },
    },
    tasks: {
      empty: '予定作業なし。',
      cardsAria: '予定作業カード',
      groups: {
        watchers: 'CI監視',
        scheduled: '予定',
        paused: '一時停止',
        completed: '完了',
      },
      count: '件',
      groupEmpty: 'なし',
      task: '作業',
      status: '状態',
      schedule: '予定',
      next: '次回',
      last: '直近',
      context: 'コンテキスト',
      ciWatch: 'CI監視',
      emptyPrompt: '（空のプレビュー）',
      prompt: 'プロンプト',
      until: 'まで',
      suspendedUntil: '再開',
      lastResult: '直近結果',
      result: '結果なし',
      resultOk: '正常',
      resultFail: '失敗',
      noResult: '結果なし',
      noTime: '-',
      now: '今',
      createTitle: 'Create task',
      createSubtitle: 'Schedule work from web',
      room: 'Room',
      selectRoom: 'Select room',
      scheduleType: 'Type',
      scheduleValue: 'Value',
      scheduleValueHint: 'ISO time, ms, or cron',
      promptPlaceholder: 'What should the agent do?',
      editPromptPlaceholder: 'Leave blank to keep prompt',
      scheduleTypes: {
        once: 'Once',
        interval: 'Interval',
        cron: 'Cron',
      },
      contextModes: {
        isolated: 'Isolated',
        group: 'Group',
      },
      actions: {
        create: 'Create',
        edit: 'Edit',
        save: 'Save',
        pause: 'Pause',
        resume: 'Resume',
        cancel: 'Cancel',
        busy: 'Working',
        confirmCancel: 'Cancel this scheduled work?',
      },
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
