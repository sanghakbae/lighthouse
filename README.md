# Lighthouse UI

Chrome DevTools Lighthouse와 유사한 웹 성능 분석 도구.
**배포**: https://lh.sanghak.kr

## 기능

- **4가지 장치** — iPhone / Galaxy / iPad / Desktop
- **4가지 카테고리** — 성능 · 접근성 · 권장사항 · SEO
- **실제 사용자 데이터(CrUX)** — PageSpeed Insights처럼 실제 방문자의 Core Web Vitals
  (LCP·INP·CLS·FCP·TTFB) 분포 막대 + **Core Web Vitals 평가(통과/실패)** 배지 (`CRUX_API_KEY` 필요)
- **세션(로그인 분석)** — 세션 쿠키를 주입해 **로그인된 페이지**를 분석 (선택)
  - `세션 토글 ON` → 쿠키 입력 (`name=value` 형식, 여러 개는 `;` 구분)
  - 예: `security_portal_auth=portal-v1.eyJ...` → Lighthouse·스크린샷이 인증된 화면을 분석/캡처
  - 쿠키 이름(`=` 앞부분)이 리포트 그룹 라벨로 사용됨. `=`가 없으면 단순 그룹 이름으로 동작
  - ⚠ 쿠키 값은 민감정보 — URL/DB에는 라벨만 저장, 쿠키 값은 분석 요청에만 사용
- **Firebase Firestore** — 리포트 저장 (점수 + 구조화 데이터 + 전체 마크다운 문서, 세션별 조회·필터)
- **장치 미리보기** — 선택한 장치 크기로 실제 사이트 렌더링
  - 📸 **스크린샷** 모드: 서버 헤드리스 Chrome 캡처 (정적 이미지)
  - 🪟 **실시간** 모드: 서버 경로 프록시(`/proxy`, `/p/`)로 X-Frame-Options/CSP를 우회하고
    JS/CSS를 동일출처로 제공 → **SPA도 실제 구동되는 인터랙티브 미리보기**
  - 로그인된 화면을 보려면 세션 쿠키(`name=value`)를 입력하면 프록시가 함께 전달
- **로컬 히스토리** — 이 브라우저의 최근 분석 기록 (📋)
- **100% 반응형** — 모바일~데스크톱 본문 폭 자동 조정
- **GitHub Pages** — 정적 프론트엔드 자동 배포 + 커스텀 도메인

> ⚠️ **보안 주의**: 실시간 프록시(`/proxy`, `/p/`)와 스크린샷 기능은 임의의 URL을 서버가 대신 요청합니다(오픈 프록시 성격). **로컬 개발 용도로만** 실행하고, 공개 인터넷에 그대로 노출하지 마세요.

## 아키텍처

```
[브라우저] ──분석요청──► [로컬 Node 서버] ──Lighthouse 실행──► 결과
     │
     └──점수 + 구조화 데이터 + 마크다운──► Firebase Firestore (세션별)
```

- **분석 실행**: 로컬 Node 서버(Chrome headless). GitHub Pages에선 ⚙ 설정에서 서버 URL 연결.
- **저장**: Firestore를 클라이언트에서 직접 사용 (서버 스토리지 키 불필요). 별도 S3/R2 없음.

## 빠른 시작

```bash
git clone https://github.com/sanghakbae/lighthouse
cd lighthouse
npm install
cp .env.example .env   # CrUX 키 입력 (선택)
npm start              # http://localhost:3000
```

## 실제 사용자 데이터 (CrUX / PageSpeed Insights 필드 데이터)

[pagespeed.web.dev](https://pagespeed.web.dev/)처럼 실제 방문자의 Core Web Vitals를 보여줍니다.
Google [Chrome UX Report API](https://developer.chrome.com/docs/crux/api) 키가 필요합니다:

1. Google Cloud Console → **Chrome UX Report API** 사용 설정 → API 키 발급
2. `.env`에 `CRUX_API_KEY=...` 추가
3. 분석 결과 상단에 LCP·INP·CLS·FCP·TTFB 분포와 **Core Web Vitals 통과/실패** 배지 표시

> 방문자 수가 적은 사이트는 Google이 필드 데이터를 제공하지 않아(no-data) 랩 데이터만 표시됩니다.

## 리포트 (마크다운)

분석 결과 화면 우측 상단 **⬇ 마크다운** 버튼으로 리포트를 `.md` 파일로 내려받습니다.
- 점수 요약 / 핵심 지표 표
- 카테고리별 **개선 필요** · **통과** 항목 (한글 제목·상세 설명·세부 표 포함)
- Lighthouse `locale: 'ko'` 적용 → 크롬 라이트하우스 한글 리포트와 동일한 번역

## Firebase 설정 (Firestore 권한 오류 해결)

> **"Missing or insufficient permissions"** 오류는 Firestore 보안 규칙이 닫혀 있어서 발생합니다.

`public/index.html` 상단 `firebaseConfig`에 프로젝트(`lighthouse-3d4ff`)가 설정되어 있습니다.
[firestore.rules](firestore.rules)를 적용하세요 — 두 가지 방법:

**방법 A. Firebase 콘솔 (가장 빠름)**
1. [Firebase 콘솔](https://console.firebase.google.com/project/lighthouse-3d4ff/firestore) → Firestore Database 생성 (없으면)
2. **규칙(Rules)** 탭 → [firestore.rules](firestore.rules) 내용 붙여넣기 → **게시(Publish)**

**방법 B. Firebase CLI**
```bash
npm i -g firebase-tools
firebase login
firebase deploy --only firestore:rules --project lighthouse-3d4ff
```

규칙 적용 후 "저장된 리포트" 탭이 정상 동작합니다.

## GitHub Pages 배포 + 커스텀 도메인

1. Settings → Pages → Source: **GitHub Actions**
2. `main` 브랜치 push → [deploy.yml](.github/workflows/deploy.yml)이 `public/`을 배포
3. 커스텀 도메인 `lh.sanghak.kr` ([public/CNAME](public/CNAME))
   - DNS에 CNAME 레코드: `lh` → `<username>.github.io`
