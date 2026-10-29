create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  join_code text not null unique default upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)),
  alert_email text, billing_email text,
  vat_on boolean not null default true, vat_rate numeric not null default 0.2,
  weekly_price numeric not null default 1,
  min_total_secs int not null default 0,
  checklist jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  password_hash text not null,
  company_id uuid references companies(id) on delete cascade,
  full_name text not null default '',
  role text not null default 'driver' check (role in ('driver','admin')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists users_email_idx on users (lower(email));
create index if not exists users_company_idx on users (company_id);
create table if not exists vehicles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  reg text not null, type text not null default 'Truck',
  added_on date not null default current_date, removed_on date,
  created_at timestamptz not null default now()
);
create index if not exists vehicles_company_idx on vehicles (company_id);
create table if not exists checks (
  id uuid primary key,
  company_id uuid not null references companies(id) on delete cascade,
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  driver_id uuid not null references users(id),
  started_at timestamptz not null default now(), finished_at timestamptz,
  start_lat double precision, start_lng double precision, start_acc real,
  end_lat double precision, end_lng double precision,
  distance_m real, heading_coverage int, duration_secs int,
  plate_photo text, licence text, mileage int,
  results jsonb not null default '{}'::jsonb, defects jsonb not null default '[]'::jsonb,
  notes text, flags text[] not null default '{}',
  verdict text not null default 'pass' check (verdict in ('pass','defect','flagged')),
  fixed boolean not null default false
);
create index if not exists checks_company_idx on checks (company_id, started_at desc);
create index if not exists checks_driver_idx on checks (driver_id, started_at desc);
create index if not exists checks_vehicle_idx on checks (vehicle_id, started_at desc);
create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  check_id uuid references checks(id) on delete cascade,
  kind text not null, message text not null,
  resolved boolean not null default false, emailed boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists alerts_company_idx on alerts (company_id, created_at desc);
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  number text not null unique, period date not null,
  lines jsonb not null, weeks int not null,
  subtotal numeric not null, vat numeric not null, total numeric not null,
  status text not null default 'unpaid' check (status in ('unpaid','paid','void')),
  issued_on date not null default current_date, due_on date not null default current_date + 14,
  paid_on date,
  unique (company_id, period)
);

-- weeks started in a month for one vehicle: 7-day blocks from the day added, any block started in the month counts in full
create or replace function weeks_in_month(p_added date, p_removed date, p_month date) returns int
language plpgsql immutable as $$
declare ms date := date_trunc('month', p_month)::date;
  me date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  hi date; kmin int; kmax int;
begin
  hi := least(me, coalesce(p_removed, me));
  if hi < p_added then return 0; end if;
  kmin := greatest(0, ceil((ms - p_added)::numeric / 7)::int);
  kmax := floor((hi - p_added)::numeric / 7)::int;
  return greatest(0, kmax - kmin + 1);
end $$;

create or replace function generate_invoices(p_month date) returns int language plpgsql as $$
declare c record; ln jsonb; w int; sub numeric; vt numeric; n int := 0; seq int; per date := date_trunc('month', p_month)::date;
begin
  for c in select * from companies loop
    if exists (select 1 from invoices where company_id=c.id and period=per) then continue; end if;
    select coalesce(jsonb_agg(jsonb_build_object('reg',reg,'type',type,'weeks',wk,'amount',wk*c.weekly_price) order by reg),'[]'), coalesce(sum(wk),0)
      into ln, w from (select reg, type, weeks_in_month(added_on, removed_on, per) wk from vehicles where company_id=c.id) x where wk>0;
    if w = 0 then continue; end if;
    sub := w * c.weekly_price; vt := case when c.vat_on then round(sub*c.vat_rate,2) else 0 end;
    select count(*)+1 into seq from invoices;
    insert into invoices(company_id, number, period, lines, weeks, subtotal, vat, total)
    values (c.id, 'KOVI-'||to_char(per,'YYMM')||'-'||lpad(seq::text,4,'0'), per, ln, w, sub, vt, sub+vt);
    n := n + 1;
  end loop;
  return n;
end $$;
