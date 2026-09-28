-- Supabase SQL Editor에서 한 번 실행.
-- 이메일 확인은 Supabase Authentication > Providers > Email에서 꺼야
-- 게임 전용 아이디로 가입 직후 로그인할 수 있다. Auth의 이메일·비밀번호 인증을 사용한다.
create table if not exists public.game_progress (
    user_id uuid primary key references auth.users(id) on delete cascade,
    save_data jsonb not null,
    updated_at timestamptz not null default now(),
    constraint game_progress_valid check (
      jsonb_typeof(save_data) = 'object'
      and save_data->>'app' = 'YFM'
      and jsonb_typeof(save_data->'data') = 'object'
      and pg_column_size(save_data) <= 5242880
    )
);
alter table public.game_progress enable row level security;
revoke all on public.game_progress from anon;
grant select, insert, update on public.game_progress to authenticated;

drop policy if exists game_progress_select_own on public.game_progress;
create policy game_progress_select_own on public.game_progress for select to authenticated
using ((select auth.uid()) = user_id and (select auth.jwt()->>'is_anonymous') is distinct from 'true');
drop policy if exists game_progress_insert_own on public.game_progress;
create policy game_progress_insert_own on public.game_progress for insert to authenticated
with check ((select auth.uid()) = user_id and (select auth.jwt()->>'is_anonymous') is distinct from 'true');
drop policy if exists game_progress_update_own on public.game_progress;
create policy game_progress_update_own on public.game_progress for update to authenticated
using ((select auth.uid()) = user_id and (select auth.jwt()->>'is_anonymous') is distinct from 'true')
with check ((select auth.uid()) = user_id and (select auth.jwt()->>'is_anonymous') is distinct from 'true');
