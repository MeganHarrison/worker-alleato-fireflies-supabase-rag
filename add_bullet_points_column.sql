-- Add bullet_points column to documents table for Fireflies bullet_gist data
ALTER TABLE documents
ADD COLUMN IF NOT EXISTS bullet_points TEXT[];

-- Add index for better query performance
CREATE INDEX IF NOT EXISTS idx_documents_bullet_points ON documents USING GIN(bullet_points);

-- Update the meeting_documents view to include bullet_points
DROP VIEW IF EXISTS meeting_documents CASCADE;

CREATE OR REPLACE VIEW meeting_documents AS
SELECT 
  d.*,
  p.name as project_name,
  p."job number" as project_job_number,
  CASE 
    WHEN d.sentiment_scores->>'positive_pct' IS NOT NULL 
    THEN (d.sentiment_scores->>'positive_pct')::FLOAT
    ELSE NULL
  END as positive_sentiment_pct,
  CASE 
    WHEN d.sentiment_scores->>'negative_pct' IS NOT NULL 
    THEN (d.sentiment_scores->>'negative_pct')::FLOAT
    ELSE NULL
  END as negative_sentiment_pct,
  CASE 
    WHEN d.sentiment_scores->>'neutral_pct' IS NOT NULL 
    THEN (d.sentiment_scores->>'neutral_pct')::FLOAT
    ELSE NULL
  END as neutral_sentiment_pct
FROM documents d
LEFT JOIN projects p ON d.project_id = p.id
WHERE d.category = 'meeting' OR d.source LIKE '%meeting%' OR d.fireflies_id IS NOT NULL
ORDER BY d.meeting_date DESC NULLS LAST, d.created_at DESC;

-- Grant permissions
GRANT SELECT ON meeting_documents TO authenticated;

-- Add computed column for bullet points count
ALTER TABLE documents
ADD COLUMN IF NOT EXISTS bullet_points_count INTEGER GENERATED ALWAYS AS (
  CASE 
    WHEN bullet_points IS NULL THEN 0
    ELSE array_length(bullet_points, 1)
  END
) STORED;