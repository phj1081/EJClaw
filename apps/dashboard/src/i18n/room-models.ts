import type { Locale } from '../i18n';

export interface RoomModelMessages {
  title: string;
  hint: string;
  empty: string;
  globalDefault: string;
  applyHint: string;
  updateFailed: string;
}

export const roomModelMessages = {
  ko: {
    title: '방별 모델',
    hint: '방·역할별로 모델과 추론 강도를 덮어씁니다. 비워 두면 전역 설정을 따릅니다.',
    empty: '등록된 방 없음',
    globalDefault: '전역 기본{value}',
    applyHint:
      'tribunal 방은 다음 턴부터 즉시 적용됩니다. single 방은 재시작 후 적용됩니다.',
    updateFailed: '방별 모델 저장 실패',
  },
  en: {
    title: 'Per-room models',
    hint: 'Override model and effort per room and role. Leave empty to inherit the global setting.',
    empty: 'No rooms registered',
    globalDefault: 'Global default{value}',
    applyHint:
      'Tribunal rooms apply from the next turn. Single rooms apply after a restart.',
    updateFailed: 'Failed to save room model',
  },
  zh: {
    title: '按房间模型',
    hint: '按房间和角色覆盖模型与推理强度。留空则继承全局设置。',
    empty: '暂无已注册房间',
    globalDefault: '全局默认{value}',
    applyHint: 'Tribunal 房间下一轮生效；single 房间重启后生效。',
    updateFailed: '保存房间模型失败',
  },
  ja: {
    title: 'ルーム別モデル',
    hint: 'ルームとロールごとにモデルと推論強度を上書きします。空欄ならグローバル設定を継承します。',
    empty: '登録済みルームなし',
    globalDefault: 'グローバル既定{value}',
    applyHint:
      'tribunal ルームは次ターンから適用。single ルームは再起動後に適用されます。',
    updateFailed: 'ルーム別モデルの保存に失敗しました',
  },
} as const satisfies Record<Locale, RoomModelMessages>;
