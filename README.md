# Friend Guest Book

GitHub Pages + Supabase 기반 실시간 방명록입니다.

- `/write.html`: 누구나 메시지 작성 (anon insert 허용)
- `/live.html`: 관리자 로그인 후 실시간 보기
  - 좌측: 실시간 방명록
  - 우측: PDF 업로드/삭제/선택 + 뷰어

## 1. Supabase SQL 적용

Supabase SQL Editor에서 아래 파일을 실행하세요.

- `supabase/schema.sql`

그리고 Realtime에서 아래 테이블을 활성화하세요.

- `public.guestbook_messages`
- `public.event_settings`

이 SQL에는 아래가 포함되어 있습니다.

- `guestbook_messages` 테이블
- `admin_accounts` 테이블
- `event_settings` 테이블
- `is_admin()` 함수
- RLS 정책 (관리자 전용 조회/스토리지 제어)
- Storage bucket (`event-pdfs`) 생성/정책

## 2. 관리자 계정 등록

`/live.html`은 Supabase Auth 로그인 + `is_admin()` 권한 확인을 통과해야 접근됩니다.

1. Supabase Auth에서 관리자 이메일 계정 생성
2. `public.admin_accounts`에 같은 이메일 등록

예시 SQL:

```sql
insert into public.admin_accounts (email, is_active)
values ('your-admin-auth-email@example.com', true)
on conflict (email) do update set is_active = true;
```

## 3. 환경변수

`.env.example`를 복사해 `.env`를 만드세요.

```bash
cp .env.example .env
```

| key | 설명 |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase 프로젝트 URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key |
| `VITE_ADMIN_EMAIL` | `/live.html` 로그인 폼 기본 이메일 (선택) |
| `VITE_DEFAULT_EVENT_ID` | 기본 행사 코드 |
| `VITE_DEFAULT_PDF_URL` | `event_settings`가 비어 있을 때만 쓰는 초기 PDF URL (선택) |
| `VITE_PDF_STORAGE_BUCKET` | PDF 저장 bucket 이름 (기본 `event-pdfs`) |

중요:
- `VITE_`로 시작하는 값은 브라우저 번들에 노출됩니다.
- `VITE_ADMIN_EMAIL`은 노출되어도 되지만, 관리자 비밀번호/서비스 키 같은 비밀값은 절대 `VITE_`로 두면 안 됩니다.

## 4. 로컬 실행

```bash
npm install
npm run dev
```

## 5. URL 사용법

행사별 분리:

- 작성: `/write.html?event=spring-assembly-2026`
- 보기: `/live.html?event=spring-assembly-2026`
- 프로젝터(관리 버튼 숨김): `/live.html?event=spring-assembly-2026&projector=1`

## 6. GitHub Pages 배포 (`npm run deploy`)

### 1) GitHub Pages source 설정

GitHub 저장소 `Settings > Pages`에서 아래로 설정하세요.

- Source: **Deploy from a branch**
- Branch: **gh-pages** / **root**

### 2) 배포 명령 실행

```bash
npm run deploy
```

첫 배포 전에 동작만 확인하려면:

```bash
npm run deploy:dry-run
```

참고:
- 배포 스크립트는 `scripts/deploy-pages.mjs`이며 `remote.origin.url`에서 저장소 이름을 읽어 `VITE_BASE_PATH`를 자동 설정합니다.
- HTTPS/SSH 인증이 되어 있어야 `gh-pages` 브랜치 push가 성공합니다.

### 3) GitHub Actions 배포를 계속 쓰고 싶다면

워크플로 파일:

- `.github/workflows/deploy-pages.yml`

`Settings > Pages`에서 Source를 **GitHub Actions**로 바꾸면 기존 Actions 방식도 그대로 사용할 수 있습니다.
