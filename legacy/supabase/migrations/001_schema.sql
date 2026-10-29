-- Kovi Fleet: schema, RLS, billing functions

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  join_code text not null unique default upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)),
  alert_email text,
  billing_email text,
  vat_on boolean not null default true,
  vat_rate numeric not null default 0.2,
  weekly_price numeric not null default 1,
  min_total_secs int not null default 60,
  checklist jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  company_id uuid references public.companies(id) on delete cascade,
  full_name text not null default '',
  email text,
  role text not null default 'driver' check (role in ('driver','admin')),
  active boolean not null default true,
  is_platform_admin boolean not null default false,
  created_at timestamptz not null default now()
);
create index on public.profiles(company_id);

create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  reg text not null,
  type text not null default 'Truck',
  added_on date not null default current_date,
  removed_on date,
  created_at timestamptz not null default now()
);
create index on public.vehicles(company_id);

create table public.checks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  driver_id uuid not null references public.profiles(id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  start_lat double precision, start_lng double precision, start_acc real,
  end_lat double precision, end_lng double precision,
  distance_m real,
  heading_coverage int,
  duration_secs int,
  plate_photo text,
  licence text, mileage int,
  results jsonb not null default '{}'::jsonb,
  defects jsonb not null default '[]'::jsonb,
  notes text,
  flags text[] not null default '{}',
  verdict text not null default 'pass' check (verdict in ('pass','defect','flagged')),
  fixed boolean not null default false
);
create index on public.checks(company_id, started_at desc);
create index on public.checks(vehicle_id, started_at desc);

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  check_id uuid references public.checks(id) on delete cascade,
  kind text not null,
  message text not null,
  resolved boolean not null default false,
  emailed boolean not null default false,
  created_at timestamptz not null default now()
);
create index on public.alerts(company_id, created_at desc);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  number text not null unique,
  period date not null,
  lines jsonb not null,
  weeks int not null,
  subtotal numeric not null,
  vat numeric not null,
  total numeric not null,
  status text not null default 'unpaid' check (status in ('unpaid','paid','void')),
  issued_on date not null default current_date,
  due_on date not null default current_date + 14,
  paid_on date,
  unique (company_id, period)
);

-- helpers
create or replace function public.my_company() returns uuid language sql stable security definer set search_path=public as
$$ select company_id from public.profiles where id = auth.uid() $$;
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path=public as
$$ select coalesce((select role='admin' and active from public.profiles where id=auth.uid()),false) $$;
create or replace function public.is_platform() returns boolean language sql stable security definer set search_path=public as
$$ select coalesce((select is_platform_admin from public.profiles where id=auth.uid()),false) $$;

alter table public.companies enable row level security;
alter table public.profiles enable row level security;
alter table public.vehicles enable row level security;
alter table public.checks enable row level security;
alter table public.alerts enable row level security;
alter table public.invoices enable row level security;

create policy co_sel on public.companies for select using (id = public.my_company() or public.is_platform());
create policy co_upd on public.companies for update using (id = public.my_company() and public.is_admin()) with check (id = public.my_company());

create policy pr_sel on public.profiles for select using (id = auth.uid() or company_id = public.my_company() or public.is_platform());
create policy pr_upd on public.profiles for update using (company_id = public.my_company() and public.is_admin() and id <> auth.uid()) with check (company_id = public.my_company());

create policy ve_sel on public.vehicles for select using (company_id = public.my_company() or public.is_platform());
create policy ve_ins on public.vehicles for insert with check (company_id = public.my_company() and public.is_admin());
create policy ve_upd on public.vehicles for update using (company_id = public.my_company() and public.is_admin()) with check (company_id = public.my_company());

create policy ch_sel on public.checks for select using ((company_id = public.my_company() and (public.is_admin() or driver_id = auth.uid())) or public.is_platform());
create policy ch_ins on public.checks for insert with check (company_id = public.my_company() and driver_id = auth.uid());
create policy ch_upd on public.checks for update using (company_id = public.my_company() and public.is_admin()) with check (company_id = public.my_company());

create policy al_sel on public.alerts for select using (company_id = public.my_company() and public.is_admin());
create policy al_upd on public.alerts for update using (company_id = public.my_company() and public.is_admin()) with check (company_id = public.my_company());

create policy in_sel on public.invoices for select using ((company_id = public.my_company() and public.is_admin()) or public.is_platform());
create policy in_upd on public.invoices for update using (public.is_platform()) with check (true);

-- signup: first admin creates a company
create or replace function public.create_company(p_name text, p_full_name text) returns uuid
language plpgsql security definer set search_path=public as $$
declare cid uuid; em text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists (select 1 from profiles where id=auth.uid() and company_id is not null) then raise exception 'already in a company'; end if;
  select email into em from auth.users where id=auth.uid();
  insert into companies(name, alert_email, billing_email, checklist) values (p_name, em, em, public.default_checklist()) returning id into cid;
  insert into profiles(id, company_id, full_name, email, role) values (auth.uid(), cid, p_full_name, em, 'admin')
    on conflict (id) do update set company_id=cid, full_name=p_full_name, email=em, role='admin';
  return cid;
end $$;

-- signup: driver joins with company code
create or replace function public.join_company(p_code text, p_full_name text) returns uuid
language plpgsql security definer set search_path=public as $$
declare cid uuid; em text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists (select 1 from profiles where id=auth.uid() and company_id is not null) then raise exception 'already in a company'; end if;
  select id into cid from companies where join_code = upper(trim(p_code));
  if cid is null then raise exception 'Company code not found'; end if;
  select email into em from auth.users where id=auth.uid();
  insert into profiles(id, company_id, full_name, email, role) values (auth.uid(), cid, p_full_name, em, 'driver')
    on conflict (id) do update set company_id=cid, full_name=p_full_name, email=em, role='driver';
  return cid;
end $$;

create or replace function public.default_checklist() returns jsonb language sql immutable as $$
select '[
 {"id":"cab","title":"Cab & lights","secs":5,"walk":false,"items":["Windscreen and wipers","Mirrors","Horn","Dashboard warning lights","Seat belt","Cab lights and indicators"]},
 {"id":"out","title":"Walk round vehicle","secs":12,"walk":true,"items":["Tyres and wheel nuts","Lights, reflectors and number plates","Body, doors and load security","Fluid leaks","Fuel cap and AdBlue cap"]},
 {"id":"trl","title":"Trailer / body","secs":8,"walk":false,"items":["Coupling and air lines","Landing legs","Curtains / doors / tail lift","Load restraints"]},
 {"id":"saf","title":"Safety kit","secs":5,"walk":false,"items":["Fire extinguisher","First aid kit","Warning triangle","Hi-vis and spare bulbs"]}
]'::jsonb $$;

-- Weeks started in a month for one vehicle: 7-day blocks counted from the day added; any block started in the month counts in full.
create or replace function public.weeks_in_month(p_added date, p_removed date, p_month date) returns int
language plpgsql immutable as $$
declare ms date := date_trunc('month', p_month)::date; me date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  hi date := least(me, coalesce(p_removed, me)); kmin int; kmax int;
begin
  if hi < p_added then return 0; end if;
  kmin := greatest(0, ceil((ms - p_added)::numeric / 7)::int);
  kmax := floor((hi - p_added)::numeric / 7)::int;
  return greatest(0, kmax - kmin + 1);
end $$;

create or replace function public.generate_invoices(p_month date default (date_trunc('month', now()) - interval '1 month')::date) returns int
language plpgsql security definer set search_path=public as $$
declare c record; ln jsonb; w int; sub numeric; vt numeric; n int := 0; seq int; per date := date_trunc('month', p_month)::date;
begin
  if auth.uid() is not null and not public.is_platform() then raise exception 'not allowed'; end if;
  for c in select * from companies loop
    if exists (select 1 from invoices where company_id=c.id and period=per) then continue; end if;
    select coalesce(jsonb_agg(jsonb_build_object('reg',reg,'type',type,'weeks',wk,'amount',wk*c.weekly_price) order by reg),'[]'), coalesce(sum(wk),0)
      into ln, w
      from (select reg, type, public.weeks_in_month(added_on, removed_on, per) wk from vehicles where company_id=c.id) x where wk>0;
    if w = 0 then continue; end if;
    sub := w * c.weekly_price; vt := case when c.vat_on then round(sub*c.vat_rate,2) else 0 end;
    select count(*)+1 into seq from invoices;
    insert into invoices(company_id, number, period, lines, weeks, subtotal, vat, total)
    values (c.id, 'KOVI-'||to_char(per,'YYMM')||'-'||lpad(seq::text,4,'0'), per, ln, w, sub, vt, sub+vt);
    n := n + 1;
  end loop;
  return n;
end $$;

-- live usage this month for the billing screen
create or replace function public.usage_now() returns jsonb language plpgsql stable security definer set search_path=public as $$
declare c companies; rows jsonb; w int;
begin
  select * into c from companies where id=public.my_company();
  select coalesce(jsonb_agg(jsonb_build_object('reg',reg,'type',type,'added',added_on,'removed',removed_on,'weeks',wk) order by reg),'[]'), coalesce(sum(wk),0)
   into rows, w from (select reg,type,added_on,removed_on, public.weeks_in_month(added_on,removed_on,current_date) wk from vehicles where company_id=c.id) x where wk>0;
  return jsonb_build_object('rows',rows,'weeks',w,'subtotal',w*c.weekly_price,'vat_on',c.vat_on,'vat_rate',c.vat_rate,'price',c.weekly_price);
end $$;

revoke all on function public.generate_invoices(date) from public, anon;
grant execute on function public.generate_invoices(date) to authenticated, service_role;
grant execute on function public.create_company(text,text), public.join_company(text,text), public.usage_now() to authenticated;
revoke execute on function public.create_company(text,text), public.join_company(text,text), public.usage_now() from anon;
