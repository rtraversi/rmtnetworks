-- clients-schema-v7.sql — Pipeline stages, Activity timeline, Tasks & Milestones
-- Run in Supabase SQL Editor after v6.

-- 1. Pipeline fields on clients (only meaningful while status = 'prospect')
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS pipeline_stage text DEFAULT 'new_lead'
    CHECK (pipeline_stage IN ('new_lead','contacted','proposal_sent','won','lost')),
  ADD COLUMN IF NOT EXISTS deal_value  numeric(10,2),
  ADD COLUMN IF NOT EXISTS lost_reason text;

-- 2. Activity timeline — calls/emails/meetings/notes, plus system-logged
--    stage/status changes and task completions, all in one chronological feed.
CREATE TABLE IF NOT EXISTS client_activities (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  type        text        NOT NULL DEFAULT 'note' CHECK (type IN ('call','email','meeting','note','system')),
  body        text        NOT NULL,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_activities_client ON client_activities(client_id, created_at DESC);

ALTER TABLE client_activities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anon full access" ON client_activities;
CREATE POLICY "Anon full access" ON client_activities FOR ALL USING (true) WITH CHECK (true);

-- 3. Tasks & Milestones — a milestone is just a task with is_milestone = true,
--    rendered bigger/highlighted and able to carry a sub-checklist.
CREATE TABLE IF NOT EXISTS client_tasks (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title         text        NOT NULL,
  description   text,
  due_date      date,
  assignee      text,
  is_milestone  boolean     NOT NULL DEFAULT false,
  status        text        NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  completed_at  timestamptz,
  sort_order    integer     NOT NULL DEFAULT 0,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_tasks_client ON client_tasks(client_id, status, due_date);

ALTER TABLE client_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anon full access" ON client_tasks;
CREATE POLICY "Anon full access" ON client_tasks FOR ALL USING (true) WITH CHECK (true);

-- 4. Milestone sub-checklist items (only used when the parent task is a milestone)
CREATE TABLE IF NOT EXISTS client_milestone_items (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid        NOT NULL REFERENCES client_tasks(id) ON DELETE CASCADE,
  title       text        NOT NULL,
  done        boolean     NOT NULL DEFAULT false,
  sort_order  integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_milestone_items_task ON client_milestone_items(task_id);

ALTER TABLE client_milestone_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anon full access" ON client_milestone_items;
CREATE POLICY "Anon full access" ON client_milestone_items FOR ALL USING (true) WITH CHECK (true);
