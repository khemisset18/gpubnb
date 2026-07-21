create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  pseudonym text not null unique check (pseudonym ~ '^[A-Za-z0-9_-]{3,32}$'),
  avatar_url text,
  bio text check (char_length(bio) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "profiles_public_read" on public.profiles for select using (true);
create policy "profiles_insert_self" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles_update_self" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
revoke all on table public.profiles from anon;
grant select on table public.profiles to anon;
grant select,insert,update on table public.profiles to authenticated;
create or replace function public.protect_profile_private_fields() returns trigger language plpgsql security definer set search_path=public as $$ begin new.id=old.id; new.created_at=old.created_at; new.updated_at=now(); return new; end $$;
drop trigger if exists protect_profile_private_fields on public.profiles;
create trigger protect_profile_private_fields before update on public.profiles for each row execute function public.protect_profile_private_fields();
