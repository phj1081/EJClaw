# RUNEFALL Godot Prototype

기획서 v0.8 기준으로 만든 Godot 4 모바일 가로형 와이어프레임 프로토타입입니다. 실제 아트 에셋 없이 색 블록과 라벨로 전체 게임 틀을 먼저 검증하도록 구성했습니다.

## 실행

```bash
/snap/bin/godot-4 --path runefall-prototype
```

## 검증

```bash
/snap/bin/godot-4 --headless --path runefall-prototype --quit
/snap/bin/godot-4 --headless --path runefall-prototype --script res://scripts/smoke_test.gd
```

스모크 테스트가 성공하면 `RUNEFALL_SMOKE_OK`가 출력됩니다.

## 현재 구현 범위

- 메인 거점 화면: 파티 4인, 재화, 일일 미션, 시즌 패스, 출격 CTA
- 파티 편성 화면: 4인 슬롯, 조작 캐릭터 지정, AI 프리셋, 파티 시너지 칩
- 출격 확인 화면: 4인 파티와 AI 설정 요약
- 전투 HUD: 모바일 가로 기준 좌하단 스틱, 우하단 스킬/대시, 좌상단 파티 전환 패널
- 더미 전투 루프: 적 스폰, 자동 공격, 경험치, 전환 쿨다운, 대시, 스킬
- 레벨업/융합 오버레이: 3택 카드, 태그 색상, 융합 후보 표시
- 정산 화면: 4인 개별 성장, 보상, 한 번 더/메인 복귀

## 조작

- 이동: WASD 또는 방향키
- 대시: End 키 또는 우하단 대시 버튼
- 스킬: Space 키 또는 우하단 스킬 버튼
- 캐릭터 전환: 전투 중 좌상단 파티 패널 버튼

## 다음 개발 우선순위

1. 실제 픽셀 아트 스프라이트 연결
2. 캐릭터별 고유 무기/스킬 데이터 분리
3. AI 프리셋별 행동 차이 구현
4. 융합 매트릭스와 무기 발사체 시스템 확장
5. 장비/제작/상점/도감 화면의 실제 데이터 연결

필요 에셋 목록은 [docs/asset_request.md](docs/asset_request.md)에 정리했습니다.
