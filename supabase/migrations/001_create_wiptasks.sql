-- Create the task_status enum
CREATE TYPE task_status AS ENUM (
  'active',
  'new',
  'canceled',
  'archived',
  'deleted',
  'completed',
  'expired'
);

-- Create the wiptasks table
CREATE TABLE wiptasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_name     varchar NOT NULL,
  description   text,
  priority      integer NOT NULL DEFAULT 50 CHECK (priority >= 0 AND priority <= 100),
  current_status task_status NOT NULL DEFAULT 'new',
  type          varchar NOT NULL CHECK (type IN ('homo', 'robo')),
  agent         varchar NOT NULL,
  helpers       text[] DEFAULT ARRAY[]::text[],
  hashtag       text[] DEFAULT ARRAY[]::text[],
  expiry_date   date,
  reminder      varchar DEFAULT 'custom' CHECK (reminder IN ('hourly', 'weekly', 'monthly', 'custom')),
  events        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamp DEFAULT now(),
  updated_at    timestamp DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE wiptasks ENABLE ROW LEVEL SECURITY;

-- Allow the service role full access (edge function uses service_role key)
CREATE POLICY "Service role has full access"
  ON wiptasks
  FOR ALL
  USING (true)
  WITH CHECK (true);
