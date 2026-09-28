-- Supabase SQL Editor에서 실행하세요. 기존 owner_rankings 및 온라인 친선전 테이블은 삭제하지 않습니다.
-- Auth > Providers > Email 에서 Confirm email을 OFF로 설정해야 이메일 없는 아이디 계정이 즉시 로그인됩니다.
-- 내부 로그인 주소는 화면에 노출되지 않으며 비밀번호는 Supabase Auth가 처리합니다.
create table if not exists public.yfm_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null check (username ~ '^[A-Za-z0-9!@#^*]{3,10}$'),
  username_key text generated always as (lower(username)) stored unique,
  created_at timestamptz not null default now()
);

alter table public.yfm_accounts enable row level security;
revoke all on public.yfm_accounts from anon;
revoke insert, update, delete on public.yfm_accounts from authenticated;
grant select on public.yfm_accounts to authenticated;
drop policy if exists "Owner reads own username" on public.yfm_accounts;
create policy "Owner reads own username" on public.yfm_accounts
  for select to authenticated using ((select auth.uid()) = user_id);

create or replace function public.yfm_create_account()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  chosen text;
  internal_email text;
begin
  chosen := new.raw_user_meta_data ->> 'yfm_username';
  if chosen is null then return new; end if; -- preserves unrelated/old anonymous Auth users
  if chosen !~ '^[A-Za-z0-9!@#^*]{3,10}$' then
    raise exception 'Invalid YFM username';
  end if;
  internal_email := 'u' || encode(convert_to(lower(chosen), 'UTF8'), 'hex') || '@accounts.yfm.invalid';
  if lower(coalesce(new.email, '')) <> internal_email then
    raise exception 'Invalid YFM account address';
  end if;
  insert into public.yfm_accounts (user_id, username) values (new.id, chosen);
  return new;
end;
$$;
revoke all on function public.yfm_create_account() from public, anon, authenticated;
drop trigger if exists yfm_user_created on auth.users;
create trigger yfm_user_created after insert on auth.users
  for each row execute function public.yfm_create_account();

-- 비밀번호는 이 SQL 테이블에 저장하지 않습니다. Supabase Auth가 해시와 세션을 관리합니다.
-- 프로필 사진은 SQL/Storage에 저장하지 않고 브라우저에만 저장합니다.
-- 참고: 기존 익명 구단주 랭킹은 원래 익명 사용자 ID에 귀속됩니다. 신규 아이디 계정에서 새로 등록해야 합니다.
