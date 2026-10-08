-- Run once in the Supabase SQL editor. Never distribute the service role key.
create table public.omer_licenses (
 id uuid primary key default gen_random_uuid(),
 key_hash text unique not null,
 email text not null,
 user_id uuid unique references auth.users(id) on delete cascade,
 revoked boolean not null default false,
 expires_at timestamptz not null,
 created_at timestamptz not null default now()
);
create table public.omer_sessions (
 token_hash text primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 expires_at timestamptz not null
);
create table public.omer_data (
 user_id uuid primary key references auth.users(id) on delete cascade,
 version integer not null default 1,
 payload jsonb not null,
 constraint size_limit check (octet_length(payload::text) <= 10485760)
);
create table public.omer_usage (
 bucket text primary key,
 count integer not null default 0,
 expires_at timestamptz not null
);
alter table public.omer_licenses enable row level security;
alter table public.omer_sessions enable row level security;
alter table public.omer_data enable row level security;
alter table public.omer_usage enable row level security;
revoke all on public.omer_licenses, public.omer_sessions, public.omer_data, public.omer_usage from anon, authenticated;
-- No client policies: all access is through the server after license validation.
create function public.omer_take_quota(p_bucket text, p_limit integer, p_expires timestamptz)
returns boolean language plpgsql security definer set search_path = public as $$
declare n integer;
begin
 insert into omer_usage(bucket,count,expires_at) values(p_bucket,1,p_expires)
 on conflict(bucket) do update set count=omer_usage.count+1
 where omer_usage.count < p_limit returning count into n;
 return n is not null;
end $$;
revoke all on function public.omer_take_quota(text,integer,timestamptz) from public, anon, authenticated;
grant execute on function public.omer_take_quota(text,integer,timestamptz) to service_role;
-- Run periodically in SQL editor, or schedule with Supabase Cron:
-- delete from public.omer_usage where expires_at < now();
-- delete from public.omer_sessions where expires_at < now();
