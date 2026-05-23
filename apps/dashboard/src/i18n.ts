import { roomMessages, type RoomMessages } from './i18n/rooms';

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
    settings: string;
  };
  language: {
    label: string;
  };
  settings: {
    title: string;
    nicknameLabel: string;
    nicknamePlaceholder: string;
    nicknameHelp: string;
    languageLabel: string;
    navAria: string;
    contentAria: string;
    sidebarAria: string;
    nav: {
      general: { title: string; detail: string };
      models: { title: string; detail: string };
      runtime: { title: string; detail: string };
      moa: { title: string; detail: string };
      codex: { title: string; detail: string };
      accounts: { title: string; detail: string };
    };
    apply: {
      aria: string;
      kicker: string;
      title: string;
      hint: string;
      restart: string;
    };
    sections: {
      general: { kicker: string; title: string; description: string };
      models: { kicker: string; title: string; description: string };
      runtime: { kicker: string; title: string; description: string };
      moa: { kicker: string; title: string; description: string };
      codex: { kicker: string; title: string; description: string };
      accounts: { kicker: string; title: string; description: string };
    };
    common: {
      loading: string;
      none: string;
      saving: string;
      saved: string;
      savedRestartHint: string;
      save: string;
      delete: string;
      refresh: string;
      refreshing: string;
      refreshAll: string;
      switch: string;
      switching: string;
      default: string;
      inUse: string;
      add: string;
    };
    models: {
      roleOwner: string;
      roleReviewer: string;
      roleArbiter: string;
      roleOwnerHint: string;
      roleReviewerHint: string;
      roleArbiterHint: string;
      modelLabel: string;
      effortLabel: string;
      modelDefault: string;
      modelCustom: string;
      modelCustomLabel: string;
      modelPlaceholder: string;
      groupCodex: string;
      groupClaude: string;
      groupCustom: string;
      effortDefault: string;
      effortOptions: {
        low: string;
        medium: string;
        high: string;
        xhigh: string;
        max: string;
      };
      agentTypeLabel: string;
      agentTypeCodex: string;
      agentTypeClaude: string;
      effortInvalid: string;
      effortSaveBlocked: string;
      save: string;
      empty: string;
    };
    codex: {
      fastMode: string;
      features: string;
      codexFast: string;
      codexFastHint: string;
      claudeFast: string;
      claudeFastHint: string;
      fastModeApplyHint: string;
      goal: string;
      goalHint: string;
      goalApplyHint: string;
    };
    accounts: {
      claude: string;
      codex: string;
      noAccounts: string;
      autoRefresh: string;
      codexRefreshHint: string;
      tokenPlaceholder: string;
      deleteConfirm: string;
      refreshFailed: string;
      paymentExpired: string;
      paymentUntil: string;
      paymentUntilDays: string;
      primaryAccount: string;
      activeAccount: string;
      addTokenLabel: string;
      refreshTitle: string;
      switchTitle: string;
    };
    moa: {
      master: string;
      masterHint: string;
      save: string;
      empty: string;
      test: string;
      testing: string;
      testAfterSave: string;
      notTested: string;
      statusOk: string;
      statusFail: string;
      apiKeyPlaceholder: string;
      apiKeySet: string;
      modelLabel: string;
      baseUrlLabel: string;
      formatLabel: string;
    };
    runtime: {
      defaultHint: string;
      selectRoomLabel: string;
      selectAgentLabel: string;
      scopeCodexUser: string;
      scopeClaudeUser: string;
      scopeRunner: string;
      emptyRooms: string;
      emptySkills: string;
      agentCodex: string;
      agentClaude: string;
    };
  };
  error: {
    api: string;
    network: string;
    timeout: string;
    server: string;
    notFound: string;
    auth: string;
    unknown: string;
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
  rooms: RoomMessages;
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
    filterAll: string;
    details: string;
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
      settings: '설정',
    },
    language: {
      label: '언어',
    },
    settings: {
      title: '설정',
      nicknameLabel: '닉네임',
      nicknamePlaceholder: 'Web Dashboard',
      nicknameHelp: '룸에서 메시지 보낼 때 표시될 이름',
      languageLabel: '언어',
      navAria: '설정 섹션',
      contentAria: '설정 항목',
      sidebarAria: '설정 탐색과 적용',
      nav: {
        general: { title: '일반', detail: '표시 · 언어' },
        models: { title: '모델', detail: 'owner · reviewer · arbiter' },
        runtime: { title: '스킬', detail: '방별 ON · OFF' },
        moa: { title: 'MoA', detail: '참조 모델 · 연결 테스트' },
        codex: { title: 'Codex', detail: 'fast mode · /goal' },
        accounts: { title: '계정', detail: 'Claude · Codex' },
      },
      apply: {
        aria: '변경 적용',
        kicker: 'Apply',
        title: '저장 후 재시작',
        hint: '모델, MoA, Codex, 계정 변경은 스택 재시작 후 반영됩니다.',
        restart: '스택 재시작',
      },
      sections: {
        general: {
          kicker: 'Dashboard identity',
          title: '일반',
          description: '브라우저에서 보이는 이름과 언어만 즉시 바뀝니다.',
        },
        models: {
          kicker: 'Agent routing',
          title: '모델',
          description:
            '역할별 모델과 추론 강도를 선택합니다. 저장 후 스택 재시작이 필요합니다.',
        },
        runtime: {
          kicker: 'Agent skills',
          title: '스킬',
          description:
            '방마다 에이전트가 쓸 스킬을 켜거나 끕니다. 전역 일괄 설정은 없고, 기본값은 모두 켜짐입니다.',
        },
        moa: {
          kicker: 'Arbiter references',
          title: 'MoA 참조 모델',
          description:
            'Kimi, GLM 같은 외부 참조 모델을 켜고 연결 상태를 바로 확인합니다.',
        },
        codex: {
          kicker: 'Codex runtime',
          title: 'Codex 옵션',
          description:
            '빠른 응답과 실험 기능을 관리합니다. /goal은 여기에서 찾을 수 있습니다.',
        },
        accounts: {
          kicker: 'Credentials',
          title: '계정',
          description: 'Claude OAuth와 Codex 계정 상태를 확인하고 전환합니다.',
        },
      },
      common: {
        loading: '불러오는 중…',
        none: '없음',
        saving: '저장 중…',
        saved: '저장됨',
        savedRestartHint:
          '저장됨. 적용하려면 사이드바의 스택 재시작을 눌러 주세요.',
        save: '저장',
        delete: '삭제',
        refresh: '갱신',
        refreshing: '갱신중…',
        refreshAll: '전체 갱신',
        switch: '전환',
        switching: '전환중…',
        default: '기본',
        inUse: '사용중',
        add: '추가',
      },
      models: {
        roleOwner: 'Owner',
        roleReviewer: 'Reviewer',
        roleArbiter: 'Arbiter',
        roleOwnerHint: '작업을 직접 수행하는 에이전트',
        roleReviewerHint: '변경 사항을 검토하는 에이전트',
        roleArbiterHint: '최종 판단을 내리는 에이전트',
        modelLabel: '모델',
        effortLabel: '추론 강도',
        modelDefault: '기본값 (.env 상속)',
        modelCustom: '직접 입력…',
        modelCustomLabel: '모델 ID',
        modelPlaceholder: '예: gpt-5.5, claude-opus-4-7',
        groupCodex: 'Codex',
        groupClaude: 'Claude',
        groupCustom: '사용자 지정',
        effortDefault: '기본값 (.env 상속)',
        effortOptions: {
          low: '낮음',
          medium: '보통',
          high: '높음',
          xhigh: '매우 높음',
          max: '최대',
        },
        agentTypeLabel: '에이전트',
        agentTypeCodex: 'Codex',
        agentTypeClaude: 'Claude Code',
        effortInvalid:
          '"{value}"는 {agent}에서 지원하지 않는 추론 강도입니다. 다른 값을 선택해 주세요.',
        effortSaveBlocked:
          '지원하지 않는 추론 강도가 있습니다. 저장하기 전에 수정해 주세요.',
        save: '모델 저장',
        empty: '모델 정보 없음',
      },
      codex: {
        fastMode: '패스트 모드',
        features: 'Codex 기능',
        codexFast: 'Codex (GPT)',
        codexFastHint:
          '~/.codex/config.toml [features].fast_mode — GPT 5.5 등에서 응답 속도를 높입니다. 사용량이 더 듭니다.',
        claudeFast: 'Claude',
        claudeFastHint:
          '~/.claude/settings.json fastMode — Opus 4.x(4.6·4.7 등)에서 세션 settings.json으로 동기화됩니다.',
        fastModeApplyHint:
          '스택 재시작 없이 다음 Codex/Claude 작업부터 적용됩니다.',
        goal: 'Goals (/goal)',
        goalHint:
          '~/.codex/config.toml [features].goals — Codex 0.133 기준 opt-in 기능입니다. 기본값은 꺼짐(OFF)이며, 켜면 /goal 장기 목표 추적을 쓸 수 있습니다.',
        goalApplyHint: '스택 재시작 없이 다음 Codex 작업부터 적용됩니다.',
      },
      accounts: {
        claude: 'Claude',
        codex: 'Codex',
        noAccounts: '계정 없음',
        autoRefresh: '토큰 자동갱신',
        codexRefreshHint:
          'OAuth 토큰은 6시간마다 자동 갱신됩니다. plan 변경/해지가 즉시 반영되게 하려면 수동으로 “전체 갱신”을 누르세요.',
        tokenPlaceholder:
          'Claude OAuth 토큰 (claude CLI 로그인 후 ~/.claude/.credentials.json 에서 accessToken 값을 페이스트)',
        deleteConfirm:
          '{provider} 계정 #{index} 디렉터리를 삭제합니다. 되돌릴 수 없습니다. 계속할까요?',
        refreshFailed: '일부 갱신 실패: {indexes}',
        paymentExpired: '결제 만료 {date} ({days}일 전)',
        paymentUntil: '결제 {date}까지 ({days}일)',
        paymentUntilDays: '결제 {date}까지 ({days}일)',
        primaryAccount: '기본 계정',
        activeAccount: '사용 중',
        addTokenLabel: 'OAuth 토큰 추가',
        refreshTitle: '구독 상태를 다시 조회합니다',
        switchTitle: '다음 Codex 호출부터 이 계정을 사용합니다',
      },
      moa: {
        master: 'MoA 사용',
        masterHint:
          'Arbiter 호출 전에 외부 참조 모델 의견을 수집합니다. 저장 후 스택 재시작이 필요합니다.',
        save: 'MoA 저장',
        empty: 'MoA 설정 없음',
        test: '연결 테스트',
        testing: '테스트중…',
        testAfterSave: '저장 후 테스트',
        notTested: '연결 테스트 전',
        statusOk: '정상',
        statusFail: '실패',
        apiKeyPlaceholder: 'new API key',
        apiKeySet: 'API key set',
        modelLabel: '모델 ID',
        baseUrlLabel: 'Base URL',
        formatLabel: 'API 형식',
      },
      runtime: {
        defaultHint:
          '기본값은 모든 스킬이 켜져 있습니다. 여기서 끈 스킬만 해당 방·에이전트에 저장됩니다. 전체(모든 방) 일괄 설정은 아직 없습니다.',
        selectRoomLabel: '방 선택',
        selectAgentLabel: '에이전트',
        scopeCodexUser: 'Codex 스킬',
        scopeClaudeUser: 'Claude 스킬',
        scopeRunner: '공통 러너 스킬',
        emptyRooms: '등록된 Discord 방이 없습니다.',
        emptySkills: '이 방·에이전트에 연결된 스킬이 없습니다.',
        agentCodex: 'Codex',
        agentClaude: 'Claude Code',
      },
    },
    error: {
      api: '문제 발생',
      network: '네트워크 연결 확인 후 다시 시도해주세요.',
      timeout: '응답 시간이 초과됐어요. 잠시 후 다시 시도해주세요.',
      server: '서버에 일시적인 문제가 있어요. 잠시 후 다시 시도해주세요.',
      notFound: '요청한 정보를 찾을 수 없어요.',
      auth: '권한이 없어요. 다시 로그인해주세요.',
      unknown: '알 수 없는 오류가 발생했어요.',
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
      inboxQueue: '처리할 액션',
      usage: '사용량',
      usageWindow: '남음 / 속도',
      rooms: '룸',
      queue: '큐',
      scheduled: '예약',
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
      restart: '재시작',
      restartStack: '스택 재시작',
      restarting: '재시작 중...',
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
      empty: '처리할 Inbox 액션 없음.',
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
    rooms: roomMessages.ko,
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
      createTitle: '작업 예약',
      createSubtitle: '룸에 반복 작업 걸기',
      filterAll: '전체',
      details: '상세',
      room: '방',
      selectRoom: '방 선택',
      scheduleType: '방식',
      scheduleValue: '시간값',
      scheduleValueHint: 'ISO 시간, 10m 같은 간격, 또는 cron',
      promptPlaceholder: '에이전트가 실행할 작업을 적어주세요.',
      editPromptPlaceholder: '비우면 기존 프롬프트 유지',
      scheduleTypes: {
        once: '한 번',
        interval: '간격',
        cron: '크론',
      },
      contextModes: {
        isolated: '격리',
        group: '방 맥락',
      },
      actions: {
        create: '생성',
        edit: '수정',
        save: '저장',
        pause: '일시정지',
        resume: '재개',
        cancel: '취소',
        busy: '처리 중',
        confirmCancel: '이 예약 작업을 취소할까요?',
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
      settings: 'Settings',
    },
    language: {
      label: 'Language',
    },
    settings: {
      title: 'Settings',
      nicknameLabel: 'Nickname',
      nicknamePlaceholder: 'Web Dashboard',
      nicknameHelp: 'Name shown when sending messages from this dashboard',
      languageLabel: 'Language',
      navAria: 'Settings sections',
      contentAria: 'Settings items',
      sidebarAria: 'Settings navigation and apply',
      nav: {
        general: { title: 'General', detail: 'Display · language' },
        models: { title: 'Models', detail: 'owner · reviewer · arbiter' },
        runtime: { title: 'Skills', detail: 'per-room on/off' },
        moa: { title: 'MoA', detail: 'reference models · test' },
        codex: { title: 'Codex', detail: 'fast mode · /goal' },
        accounts: { title: 'Accounts', detail: 'Claude · Codex' },
      },
      apply: {
        aria: 'Apply changes',
        kicker: 'Apply',
        title: 'Restart after save',
        hint: 'Model, MoA, Codex, and account changes apply after a stack restart.',
        restart: 'Restart stack',
      },
      sections: {
        general: {
          kicker: 'Dashboard identity',
          title: 'General',
          description:
            'Only the display name and language change immediately in the browser.',
        },
        models: {
          kicker: 'Agent routing',
          title: 'Models',
          description:
            'Pick a model and inference depth for each role. Restart the stack after saving.',
        },
        runtime: {
          kicker: 'Agent skills',
          title: 'Skills',
          description:
            'Turn skills on or off per room and agent. Default is all on; there is no global bulk setting yet.',
        },
        moa: {
          kicker: 'Arbiter references',
          title: 'MoA reference models',
          description:
            'Enable external reference models like Kimi or GLM and verify connectivity.',
        },
        codex: {
          kicker: 'Codex runtime',
          title: 'Codex options',
          description:
            'Manage fast responses and experimental features. /goal lives here.',
        },
        accounts: {
          kicker: 'Credentials',
          title: 'Accounts',
          description: 'Review and switch Claude OAuth and Codex accounts.',
        },
      },
      common: {
        loading: 'Loading…',
        none: 'None',
        saving: 'Saving…',
        saved: 'Saved',
        savedRestartHint: 'Saved. Use Restart stack in the sidebar to apply.',
        save: 'Save',
        delete: 'Delete',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        refreshAll: 'Refresh all',
        switch: 'Switch',
        switching: 'Switching…',
        default: 'Default',
        inUse: 'In use',
        add: 'Add',
      },
      models: {
        roleOwner: 'Owner',
        roleReviewer: 'Reviewer',
        roleArbiter: 'Arbiter',
        roleOwnerHint: 'Runs the main work',
        roleReviewerHint: 'Reviews proposed changes',
        roleArbiterHint: 'Makes the final call',
        modelLabel: 'Model',
        effortLabel: 'Inference depth',
        modelDefault: 'Default (.env)',
        modelCustom: 'Custom…',
        modelCustomLabel: 'Model ID',
        modelPlaceholder: 'e.g. gpt-5.5, claude-opus-4-7',
        groupCodex: 'Codex',
        groupClaude: 'Claude',
        groupCustom: 'Custom',
        effortDefault: 'Default (.env)',
        effortOptions: {
          low: 'Low',
          medium: 'Medium',
          high: 'High',
          xhigh: 'Very high',
          max: 'Max',
        },
        agentTypeLabel: 'Agent',
        agentTypeCodex: 'Codex',
        agentTypeClaude: 'Claude Code',
        effortInvalid:
          '"{value}" is not supported for {agent}. Choose another effort level.',
        effortSaveBlocked:
          'Unsupported effort levels are set. Fix them before saving.',
        save: 'Save models',
        empty: 'No model config',
      },
      codex: {
        fastMode: 'Fast mode',
        features: 'Codex features',
        codexFast: 'Codex (GPT)',
        codexFastHint:
          '~/.codex/config.toml [features].fast_mode — faster responses on GPT 5.5 and newer; higher usage.',
        claudeFast: 'Claude',
        claudeFastHint:
          '~/.claude/settings.json fastMode — synced into session settings.json for Opus 4.x (4.6, 4.7, …).',
        fastModeApplyHint:
          'Applies on the next Codex/Claude run. No stack restart required.',
        goal: 'Goals (/goal)',
        goalHint:
          '~/.codex/config.toml [features].goals — opt-in on Codex 0.133. Off by default; enables /goal long-running objectives when on.',
        goalApplyHint:
          'Applies on the next Codex run. No stack restart required.',
      },
      accounts: {
        claude: 'Claude',
        codex: 'Codex',
        noAccounts: 'No accounts',
        autoRefresh: 'Auto token refresh',
        codexRefreshHint:
          'OAuth tokens refresh every 6 hours. Use Refresh all for immediate plan changes.',
        tokenPlaceholder:
          'Claude OAuth token (paste accessToken from ~/.claude/.credentials.json after claude CLI login)',
        deleteConfirm:
          'Delete {provider} account #{index} directory. This cannot be undone. Continue?',
        refreshFailed: 'Some refreshes failed: {indexes}',
        paymentExpired: 'Expired {date} ({days}d ago)',
        paymentUntil: 'Paid until {date} ({days}d)',
        paymentUntilDays: 'Paid until {date} ({days}d)',
        primaryAccount: 'Primary',
        activeAccount: 'Active',
        addTokenLabel: 'Add OAuth token',
        refreshTitle: 'Refresh subscription status',
        switchTitle: 'Use this account for the next Codex call',
      },
      moa: {
        master: 'Enable MoA',
        masterHint:
          'Collect external reference opinions before arbiter calls. Stack restart required after save.',
        save: 'Save MoA',
        empty: 'No MoA settings',
        test: 'Test connection',
        testing: 'Testing…',
        testAfterSave: 'Save to test',
        notTested: 'Not tested yet',
        statusOk: 'OK',
        statusFail: 'Failed',
        apiKeyPlaceholder: 'new API key',
        apiKeySet: 'API key set',
        modelLabel: 'Model ID',
        baseUrlLabel: 'Base URL',
        formatLabel: 'API format',
      },
      runtime: {
        defaultHint:
          'All skills start enabled. Only per-room, per-agent disables are saved. Global bulk settings are not available yet.',
        selectRoomLabel: 'Room',
        selectAgentLabel: 'Agent',
        scopeCodexUser: 'Codex skill',
        scopeClaudeUser: 'Claude skill',
        scopeRunner: 'Shared runner skill',
        emptyRooms: 'No registered Discord rooms.',
        emptySkills: 'No skills for this room and agent.',
        agentCodex: 'Codex',
        agentClaude: 'Claude Code',
      },
    },
    error: {
      api: 'Something went wrong',
      network: 'Check your network connection and try again.',
      timeout: 'The request timed out. Try again in a moment.',
      server: 'Server hiccup. Try again in a bit.',
      notFound: "We couldn't find what you asked for.",
      auth: 'Sign in again to continue.',
      unknown: 'An unexpected error occurred.',
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
      inboxQueue: 'Action queue',
      usage: 'Usage',
      usageWindow: 'Remaining / speed',
      rooms: 'Rooms',
      queue: 'Queue',
      scheduled: 'Scheduled',
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
      empty: 'No Inbox actions.',
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
    rooms: roomMessages.en,
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
      filterAll: 'All',
      details: 'Details',
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
      settings: '设置',
    },
    language: {
      label: '语言',
    },
    settings: {
      title: '设置',
      nicknameLabel: '昵称',
      nicknamePlaceholder: 'Web Dashboard',
      nicknameHelp: '从此面板发送消息时显示的名称',
      languageLabel: '语言',
      navAria: '设置分区',
      contentAria: '设置项',
      sidebarAria: '设置导航与应用',
      nav: {
        general: { title: '常规', detail: '显示 · 语言' },
        models: { title: '模型', detail: 'owner · reviewer · arbiter' },
        runtime: { title: '技能', detail: '按房间开关' },
        moa: { title: 'MoA', detail: '参考模型 · 连接测试' },
        codex: { title: 'Codex', detail: 'fast mode · /goal' },
        accounts: { title: '账户', detail: 'Claude · Codex' },
      },
      apply: {
        aria: '应用更改',
        kicker: 'Apply',
        title: '保存后重启',
        hint: '模型、MoA、Codex、账户更改需在栈重启后生效。',
        restart: '重启栈',
      },
      sections: {
        general: {
          kicker: 'Dashboard identity',
          title: '常规',
          description: '仅浏览器中的显示名称和语言会立即更改。',
        },
        models: {
          kicker: 'Agent routing',
          title: '模型',
          description: '为各角色选择模型和推理强度。保存后需重启栈。',
        },
        runtime: {
          kicker: 'Agent skills',
          title: '技能',
          description: '按房间和代理开关技能。默认全部开启，尚无全局批量设置。',
        },
        moa: {
          kicker: 'Arbiter references',
          title: 'MoA 参考模型',
          description: '启用 Kimi、GLM 等外部参考模型并验证连接。',
        },
        codex: {
          kicker: 'Codex runtime',
          title: 'Codex 选项',
          description: '管理快速响应和实验功能。/goal 在此设置。',
        },
        accounts: {
          kicker: 'Credentials',
          title: '账户',
          description: '查看并切换 Claude OAuth 和 Codex 账户。',
        },
      },
      common: {
        loading: '加载中…',
        none: '无',
        saving: '保存中…',
        saved: '已保存',
        savedRestartHint: '已保存。请在侧边栏点击重启栈以应用。',
        save: '保存',
        delete: '删除',
        refresh: '刷新',
        refreshing: '刷新中…',
        refreshAll: '全部刷新',
        switch: '切换',
        switching: '切换中…',
        default: '默认',
        inUse: '使用中',
        add: '添加',
      },
      models: {
        roleOwner: 'Owner',
        roleReviewer: 'Reviewer',
        roleArbiter: 'Arbiter',
        roleOwnerHint: '执行主要工作的代理',
        roleReviewerHint: '审查变更的代理',
        roleArbiterHint: '做最终裁决的代理',
        modelLabel: '模型',
        effortLabel: '推理强度',
        modelDefault: '默认 (.env)',
        modelCustom: '自定义…',
        modelCustomLabel: '模型 ID',
        modelPlaceholder: '例如 gpt-5.5, claude-opus-4-7',
        groupCodex: 'Codex',
        groupClaude: 'Claude',
        groupCustom: '自定义',
        effortDefault: '默认 (.env)',
        effortOptions: {
          low: '低',
          medium: '中',
          high: '高',
          xhigh: '很高',
          max: '最大',
        },
        agentTypeLabel: '代理',
        agentTypeCodex: 'Codex',
        agentTypeClaude: 'Claude Code',
        effortInvalid: '“{value}” 不适用于 {agent}，请选择其他推理强度。',
        effortSaveBlocked: '存在不支持的推理强度，请先修正再保存。',
        save: '保存模型',
        empty: '无模型配置',
      },
      codex: {
        fastMode: '快速模式',
        features: 'Codex 功能',
        codexFast: 'Codex (GPT)',
        codexFastHint:
          '~/.codex/config.toml [features].fast_mode — GPT 5.5 等更快响应，用量更高。',
        claudeFast: 'Claude',
        claudeFastHint:
          '~/.claude/settings.json fastMode — 同步到会话 settings.json，适用于 Opus 4.x（4.6、4.7 等）。',
        fastModeApplyHint: '无需重启栈，下次 Codex/Claude 任务起生效。',
        goal: 'Goals (/goal)',
        goalHint:
          '~/.codex/config.toml [features].goals — Codex 0.133 可选功能，默认关闭；开启后可使用 /goal。',
        goalApplyHint: '无需重启栈，下次 Codex 任务起生效。',
      },
      accounts: {
        claude: 'Claude',
        codex: 'Codex',
        noAccounts: '无账户',
        autoRefresh: '自动刷新令牌',
        codexRefreshHint:
          'OAuth 令牌每 6 小时自动刷新。计划变更请手动全部刷新。',
        tokenPlaceholder:
          'Claude OAuth 令牌（claude CLI 登录后从 ~/.claude/.credentials.json 粘贴 accessToken）',
        deleteConfirm: '将删除 {provider} 账户 #{index} 目录，无法撤销。继续？',
        refreshFailed: '部分刷新失败: {indexes}',
        paymentExpired: '已过期 {date}（{days} 天前）',
        paymentUntil: '付费至 {date}（{days} 天）',
        paymentUntilDays: '付费至 {date}（{days} 天）',
        primaryAccount: '主账户',
        activeAccount: '使用中',
        addTokenLabel: '添加 OAuth 令牌',
        refreshTitle: '重新查询订阅状态',
        switchTitle: '下次 Codex 调用起使用此账户',
      },
      moa: {
        master: '启用 MoA',
        masterHint: 'Arbiter 调用前收集外部参考意见。保存后需重启栈。',
        save: '保存 MoA',
        empty: '无 MoA 设置',
        test: '连接测试',
        testing: '测试中…',
        testAfterSave: '保存后测试',
        notTested: '尚未测试',
        statusOk: '正常',
        statusFail: '失败',
        apiKeyPlaceholder: 'new API key',
        apiKeySet: 'API key set',
        modelLabel: '模型 ID',
        baseUrlLabel: 'Base URL',
        formatLabel: 'API 格式',
      },
      runtime: {
        defaultHint:
          '默认所有技能开启。仅保存按房间、按代理的关闭项。尚无全局批量设置。',
        selectRoomLabel: '选择房间',
        selectAgentLabel: '代理',
        scopeCodexUser: 'Codex 技能',
        scopeClaudeUser: 'Claude 技能',
        scopeRunner: '共享 runner 技能',
        emptyRooms: '没有已注册的 Discord 房间。',
        emptySkills: '此房间和代理没有可用技能。',
        agentCodex: 'Codex',
        agentClaude: 'Claude Code',
      },
    },
    error: {
      api: '发生问题',
      network: '请检查网络连接后重试。',
      timeout: '请求超时,请稍后重试。',
      server: '服务器暂时出现问题,请稍后重试。',
      notFound: '找不到所请求的信息。',
      auth: '没有权限,请重新登录。',
      unknown: '发生未知错误。',
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
      inboxQueue: '待处理操作',
      usage: '用量',
      usageWindow: '剩余 / 速度',
      rooms: '房间',
      queue: '队列',
      scheduled: '计划',
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
      empty: '暂无待处理收件操作。',
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
    rooms: roomMessages.zh,
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
      filterAll: 'All',
      details: 'Details',
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
      settings: '設定',
    },
    language: {
      label: '言語',
    },
    settings: {
      title: '設定',
      nicknameLabel: 'ニックネーム',
      nicknamePlaceholder: 'Web Dashboard',
      nicknameHelp: 'このダッシュボードからメッセージを送る時に表示される名前',
      languageLabel: '言語',
      navAria: '設定セクション',
      contentAria: '設定項目',
      sidebarAria: '設定ナビと適用',
      nav: {
        general: { title: '一般', detail: '表示 · 言語' },
        models: { title: 'モデル', detail: 'owner · reviewer · arbiter' },
        runtime: { title: 'スキル', detail: 'ルーム別 ON/OFF' },
        moa: { title: 'MoA', detail: '参照モデル · 接続テスト' },
        codex: { title: 'Codex', detail: 'fast mode · /goal' },
        accounts: { title: 'アカウント', detail: 'Claude · Codex' },
      },
      apply: {
        aria: '変更を適用',
        kicker: 'Apply',
        title: '保存後に再起動',
        hint: 'モデル、MoA、Codex、アカウントの変更はスタック再起動後に反映されます。',
        restart: 'スタック再起動',
      },
      sections: {
        general: {
          kicker: 'Dashboard identity',
          title: '一般',
          description: 'ブラウザ上の表示名と言語だけがすぐに変わります。',
        },
        models: {
          kicker: 'Agent routing',
          title: 'モデル',
          description:
            '役割ごとにモデルと推論強度を選びます。保存後にスタック再起動が必要です。',
        },
        runtime: {
          kicker: 'Agent skills',
          title: 'スキル',
          description:
            'ルームとエージェントごとにスキルを ON/OFF します。デフォルトはすべて ON で、全体一括設定はまだありません。',
        },
        moa: {
          kicker: 'Arbiter references',
          title: 'MoA 参照モデル',
          description:
            'Kimi や GLM などの外部参照モデルを有効化し接続を確認します。',
        },
        codex: {
          kicker: 'Codex runtime',
          title: 'Codex オプション',
          description:
            '高速応答と実験機能を管理します。/goal はここにあります。',
        },
        accounts: {
          kicker: 'Credentials',
          title: 'アカウント',
          description: 'Claude OAuth と Codex アカウントの状態確認と切り替え。',
        },
      },
      common: {
        loading: '読み込み中…',
        none: 'なし',
        saving: '保存中…',
        saved: '保存済み',
        savedRestartHint:
          '保存済み。サイドバーのスタック再起動で適用してください。',
        save: '保存',
        delete: '削除',
        refresh: '更新',
        refreshing: '更新中…',
        refreshAll: '一括更新',
        switch: '切替',
        switching: '切替中…',
        default: 'デフォルト',
        inUse: '使用中',
        add: '追加',
      },
      models: {
        roleOwner: 'Owner',
        roleReviewer: 'Reviewer',
        roleArbiter: 'Arbiter',
        roleOwnerHint: '作業を実行するエージェント',
        roleReviewerHint: '変更をレビューするエージェント',
        roleArbiterHint: '最終判断を下すエージェント',
        modelLabel: 'モデル',
        effortLabel: '推論強度',
        modelDefault: 'デフォルト (.env)',
        modelCustom: 'カスタム…',
        modelCustomLabel: 'モデル ID',
        modelPlaceholder: '例: gpt-5.5, claude-opus-4-7',
        groupCodex: 'Codex',
        groupClaude: 'Claude',
        groupCustom: 'カスタム',
        effortDefault: 'デフォルト (.env)',
        effortOptions: {
          low: '低',
          medium: '中',
          high: '高',
          xhigh: '最高',
          max: '最大',
        },
        agentTypeLabel: 'エージェント',
        agentTypeCodex: 'Codex',
        agentTypeClaude: 'Claude Code',
        effortInvalid:
          '「{value}」は {agent} では使えない推論強度です。別の値を選んでください。',
        effortSaveBlocked:
          'サポート外の推論強度があります。保存前に修正してください。',
        save: 'モデル保存',
        empty: 'モデル情報なし',
      },
      codex: {
        fastMode: 'ファストモード',
        features: 'Codex 機能',
        codexFast: 'Codex (GPT)',
        codexFastHint:
          '~/.codex/config.toml [features].fast_mode — GPT 5.5 などで応答を高速化。使用量は増えます。',
        claudeFast: 'Claude',
        claudeFastHint:
          '~/.claude/settings.json fastMode — セッション settings.json に同期。Opus 4.x（4.6・4.7 等）向け。',
        fastModeApplyHint:
          'スタック再起動不要。次の Codex/Claude 実行から反映されます。',
        goal: 'Goals (/goal)',
        goalHint:
          '~/.codex/config.toml [features].goals — Codex 0.133 の opt-in 機能。デフォルト OFF。ON で /goal を利用。',
        goalApplyHint: 'スタック再起動不要。次の Codex 実行から反映されます。',
      },
      accounts: {
        claude: 'Claude',
        codex: 'Codex',
        noAccounts: 'アカウントなし',
        autoRefresh: 'トークン自動更新',
        codexRefreshHint:
          'OAuth トークンは 6 時間ごとに自動更新されます。プラン変更は「一括更新」を押してください。',
        tokenPlaceholder:
          'Claude OAuth トークン（claude CLI ログイン後 ~/.claude/.credentials.json の accessToken を貼り付け）',
        deleteConfirm:
          '{provider} アカウント #{index} ディレクトリを削除します。元に戻せません。続行しますか？',
        refreshFailed: '一部の更新に失敗: {indexes}',
        paymentExpired: '期限切れ {date}（{days} 日前）',
        paymentUntil: '支払い {date} まで（{days} 日）',
        paymentUntilDays: '支払い {date} まで（{days} 日）',
        primaryAccount: 'プライマリ',
        activeAccount: '使用中',
        addTokenLabel: 'OAuth トークン追加',
        refreshTitle: 'サブスクリプション状態を再取得',
        switchTitle: '次回 Codex 呼び出しからこのアカウントを使用',
      },
      moa: {
        master: 'MoA を使用',
        masterHint:
          'Arbiter 呼び出し前に外部参照モデルの意見を集めます。保存後にスタック再起動が必要です。',
        save: 'MoA 保存',
        empty: 'MoA 設定なし',
        test: '接続テスト',
        testing: 'テスト中…',
        testAfterSave: '保存後にテスト',
        notTested: '未テスト',
        statusOk: '正常',
        statusFail: '失敗',
        apiKeyPlaceholder: 'new API key',
        apiKeySet: 'API key set',
        modelLabel: 'モデル ID',
        baseUrlLabel: 'Base URL',
        formatLabel: 'API 形式',
      },
      runtime: {
        defaultHint:
          'デフォルトですべてのスキルは ON です。ルーム・エージェント単位の OFF のみ保存されます。全体一括設定はまだありません。',
        selectRoomLabel: 'ルーム',
        selectAgentLabel: 'エージェント',
        scopeCodexUser: 'Codex スキル',
        scopeClaudeUser: 'Claude スキル',
        scopeRunner: '共通 runner スキル',
        emptyRooms: '登録済み Discord ルームがありません。',
        emptySkills: 'このルームとエージェントに利用可能なスキルがありません。',
        agentCodex: 'Codex',
        agentClaude: 'Claude Code',
      },
    },
    error: {
      api: '問題が発生しました',
      network: 'ネットワーク接続を確認してから再試行してください。',
      timeout:
        'リクエストがタイムアウトしました。少し経ってから再試行してください。',
      server:
        'サーバーに一時的な問題があります。少し経ってから再試行してください。',
      notFound: 'お探しの情報が見つかりませんでした。',
      auth: '権限がありません。再ログインしてください。',
      unknown: '不明なエラーが発生しました。',
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
      inboxQueue: '対応アクション',
      usage: '使用量',
      usageWindow: '残量 / 速度',
      rooms: 'ルーム',
      queue: 'キュー',
      scheduled: '予定',
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
      empty: '対応する受信アクションはありません。',
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
    rooms: roomMessages.ja,
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
      filterAll: 'All',
      details: 'Details',
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
