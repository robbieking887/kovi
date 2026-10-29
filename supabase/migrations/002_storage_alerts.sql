-- photo bucket (private); path = <company_id>/<check_id>/<name>.jpg
insert into storage.buckets (id, name, public) values ('check-photos','check-photos',false) on conflict do nothing;

create policy "photos insert own company" on storage.objects for insert to authenticated
  with check (bucket_id='check-photos' and (storage.foldername(name))[1] = public.my_company()::text);
create policy "photos read own company (admin) or own upload" on storage.objects for select to authenticated
  using (bucket_id='check-photos' and (storage.foldername(name))[1] = public.my_company()::text and (public.is_admin() or owner = auth.uid()));

-- alerts are raised in the database so a client can't skip them
create or replace function public.raise_alerts() returns trigger language plpgsql security definer set search_path=public as $$
declare v text; d text; f text; drv text;
begin
  select reg into v from vehicles where id=new.vehicle_id;
  select full_name into drv from profiles where id=new.driver_id;
  foreach f in array new.flags loop
    insert into alerts(company_id, check_id, kind, message) values (new.company_id, new.id, 'verification',
      drv||' on '||v||': '||case f
        when 'no_gps' then 'no GPS fix, could not confirm location'
        when 'far' then 'moved more than 50 m from the vehicle during the check'
        when 'no_walk' then 'compass shows they did not walk all the way round'
        when 'too_fast' then 'check finished faster than the minimum time'
        when 'no_plate' then 'no reg plate photo'
        else f end);
  end loop;
  if jsonb_array_length(new.defects) > 0 then
    insert into alerts(company_id, check_id, kind, message) values (new.company_id, new.id, 'defect',
      drv||' reported '||jsonb_array_length(new.defects)||' defect(s) on '||v);
  end if;
  return new;
end $$;
create trigger checks_alerts after insert on public.checks for each row execute function public.raise_alerts();
