CREATE TABLE public.banned_domains (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  reason TEXT,
  blocked_url TEXT,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.banned_domains TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.banned_domains TO authenticated;
GRANT ALL ON public.banned_domains TO service_role;

ALTER TABLE public.banned_domains ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view the ban list" ON public.banned_domains FOR SELECT USING (true);
CREATE POLICY "Anyone can add a ban" ON public.banned_domains FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update a ban" ON public.banned_domains FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "Anyone can remove a ban" ON public.banned_domains FOR DELETE USING (true);