-- Supabase Database Schema for Fireflies Meeting Transcripts
-- This schema uses PostgreSQL with pgvector extension for vector similarity search

-- Enable pgvector extension (run this first in Supabase SQL Editor)
CREATE EXTENSION IF NOT EXISTS vector;

-- Create meetings table to store transcript metadata
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  date TIMESTAMP WITH TIME ZONE NOT NULL,
  duration INTEGER NOT NULL, -- in seconds
  participants TEXT[] NOT NULL,
  speaker_count INTEGER NOT NULL DEFAULT 0,
  meeting_type TEXT,
  department TEXT,
  project TEXT,
  keywords TEXT[],
  action_items TEXT[],
  file_url TEXT, -- URL to the markdown file in Supabase Storage
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create meetings_chunks table for vectorized content
CREATE TABLE IF NOT EXISTS meetings_chunks (
  id SERIAL PRIMARY KEY,
  transcript_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  speaker TEXT,
  start_time NUMERIC,
  end_time NUMERIC,
  embedding vector(768), -- BGE base model produces 768-dimensional vectors
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Ensure unique chunk index per transcript
  UNIQUE(transcript_id, chunk_index)
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(date DESC);
CREATE INDEX IF NOT EXISTS idx_meetings_department ON meetings(department);
CREATE INDEX IF NOT EXISTS idx_meetings_project ON meetings(project);
CREATE INDEX IF NOT EXISTS idx_meetings_meeting_type ON meetings(meeting_type);

-- Create indexes for chunks table
CREATE INDEX IF NOT EXISTS idx_chunks_transcript_id ON meetings_chunks(transcript_id);
CREATE INDEX IF NOT EXISTS idx_chunks_speaker ON meetings_chunks(speaker);

-- Create vector similarity search index using ivfflat
-- This significantly speeds up vector searches
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON meetings_chunks 
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Create a function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update updated_at
CREATE TRIGGER update_meetings_updated_at
  BEFORE UPDATE ON meetings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Create a view for easy searching with full metadata
CREATE OR REPLACE VIEW meeting_search_view AS
SELECT 
  c.id as chunk_id,
  c.transcript_id,
  c.chunk_index,
  c.text,
  c.speaker,
  c.start_time,
  c.end_time,
  c.embedding,
  m.title,
  m.date,
  m.duration,
  m.participants,
  m.speaker_count,
  m.meeting_type,
  m.department,
  m.project,
  m.keywords,
  m.action_items,
  m.file_url
FROM meetings_chunks c
JOIN meetings m ON c.transcript_id = m.id;

-- Function to search for similar chunks
CREATE OR REPLACE FUNCTION search_meeting_chunks(
  query_embedding vector(768),
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 10
)
RETURNS TABLE (
  chunk_id int,
  transcript_id text,
  chunk_text text,
  speaker text,
  similarity float,
  title text,
  meeting_date timestamp with time zone,
  department text,
  project text
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    c.id as chunk_id,
    c.transcript_id,
    c.text as chunk_text,
    c.speaker,
    1 - (c.embedding <=> query_embedding) as similarity,
    m.title,
    m.date as meeting_date,
    m.department,
    m.project
  FROM meetings_chunks c
  JOIN meetings m ON c.transcript_id = m.id
  WHERE 1 - (c.embedding <=> query_embedding) > match_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Create storage bucket for meeting transcripts (run in Supabase Dashboard)
-- INSERT INTO storage.buckets (id, name, public) 
-- VALUES ('meetings', 'meetings', true);

-- Row Level Security (RLS) - Adjust based on your auth requirements
ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE meetings_chunks ENABLE ROW LEVEL SECURITY;

-- Example RLS policies (adjust based on your needs)
-- Allow authenticated users to read all meetings
CREATE POLICY "Allow authenticated read access to meetings" ON meetings
  FOR SELECT USING (auth.role() = 'authenticated');

-- Allow service role full access to meetings
CREATE POLICY "Allow service role full access to meetings" ON meetings
  FOR ALL USING (auth.role() = 'service_role');

-- Allow authenticated users to read all chunks
CREATE POLICY "Allow authenticated read access to chunks" ON meetings_chunks
  FOR SELECT USING (auth.role() = 'authenticated');

-- Allow service role full access to chunks
CREATE POLICY "Allow service role full access to chunks" ON meetings_chunks
  FOR ALL USING (auth.role() = 'service_role');

-- Analytics queries examples
-- Most discussed topics
-- SELECT unnest(keywords) as keyword, COUNT(*) as frequency
-- FROM meetings
-- GROUP BY keyword
-- ORDER BY frequency DESC
-- LIMIT 20;

-- Meetings by department
-- SELECT department, COUNT(*) as meeting_count, 
--        SUM(duration)/3600 as total_hours
-- FROM meetings
-- WHERE department IS NOT NULL
-- GROUP BY department
-- ORDER BY meeting_count DESC;

-- Active participants
-- SELECT unnest(participants) as participant, COUNT(*) as meeting_count
-- FROM meetings
-- GROUP BY participant
-- ORDER BY meeting_count DESC
-- LIMIT 50;