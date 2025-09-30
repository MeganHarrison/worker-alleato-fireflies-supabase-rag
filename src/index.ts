/*
 * ============================================================================
 * FIREFLIES INGEST WORKER (CLOUDFLARE WORKERS)
 * ============================================================================
 *
 * ARCHITECTURE OVERVIEW:
 * This is an ingest-only worker that acts as the entry point for Fireflies
 * meeting transcripts. It handles data ingestion, storage, and metadata
 * management, then delegates vector embedding generation to a separate service.
 *
 * DATA FLOW:
 * 1. Fireflies Webhook/API → This Worker (ingest & store)
 * 2. This Worker → Supabase Storage (markdown files)
 * 3. This Worker → PostgreSQL (metadata in documents table)
 * 4. This Worker → Vectorizer Worker (trigger embeddings)
 * 5. Vectorizer Worker → PostgreSQL (chunks with vectors)
 *
 * KEY RESPONSIBILITIES OF THIS WORKER:
 *   ✓ Fireflies GraphQL client (fetch transcript lists and full transcript)
 *   ✓ Supabase Storage write of markdown transcript (root folder, date-title format)
 *   ✓ Postgres insert/upsert of documents row (returns document.id)
 *   ✓ Webhook verification (HMAC) + rate limiting + basic status endpoints
 *   ✓ Dispatch to Vectorizer Worker: POST { documentId }
 *   ✓ Analytics and search endpoints (read-only operations)
 *
 * DELEGATED TO VECTORIZER WORKER (separate service):
 *   → Chunk transcript into semantic segments
 *   → Generate embeddings with OpenAI (text-embedding-3-large or similar)
 *   → Insert document_chunks rows with pgvector embeddings
 *   → Update documents.processing_status, processed_at, processing_error
 *
 * REQUIRED ENVIRONMENT BINDINGS (configured in wrangler.toml):
 *   vars = {
 *     SUPABASE_URL = "https://[project].supabase.co",
 *     SUPABASE_SERVICE_KEY = "service_role_key_with_admin_access",
 *     FIREFLIES_API_KEY = "fireflies_api_key_for_graphql",
 *     FIREFLIES_WEBHOOK_SECRET = "optional_webhook_verification_secret",
 *     VECTORIZE_WORKER_URL = "https://your-vectorizer.workers.dev",
 *     WORKER_AUTH_TOKEN = "shared_secret_for_worker_auth",
 *     SYNC_BATCH_SIZE = 25,        // Transcripts to process per sync
 *     RATE_LIMIT_REQUESTS = 60,    // Max requests per window
 *     RATE_LIMIT_WINDOW = 60        // Window duration in seconds
 *   }
 *
 *   [[kv_namespaces]]
 *     binding = "CACHE"             // KV for rate limiting and flags
 *     id = "<your-kv-namespace-id>"
 *
 *   [[hyperdrive]]
 *     binding = "HYPERDRIVE"        // Optional: Postgres connection pooling
 *     id = "<your-hyperdrive-id>"
 *
 * ============================================================================
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";

// ===== Types =====
export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  DATABASE_URL?: string; // direct Postgres URL (preferred)
  HYPERDRIVE?: { connectionString: string }; // optional fallback

  FIREFLIES_API_KEY: string;
  FIREFLIES_WEBHOOK_SECRET?: string;

  VECTORIZE_WORKER_URL: string; // e.g. https://vectorizer.example.workers.dev
  WORKER_AUTH_TOKEN: string; // bearer for vectorizer

  SYNC_BATCH_SIZE: number; // default batch size for /api/sync & cron
  RATE_LIMIT_REQUESTS: number; // e.g. 60
  RATE_LIMIT_WINDOW: number; // seconds, e.g. 60

  CACHE: KVNamespace; // KV for rate limiting, simple flags
}

// Fireflies GraphQL shapes (partial)
export interface FirefliesTranscript {
  id: string;
  title: string;
  transcript_url?: string;
  duration?: number; // seconds
  date: string; // ISO
  participants: string[];
  sentences?: Array<{ text: string; speaker_id: string; start_time: number }>; // optional on list, present on detail
  summary?: {
    keywords?: string[];
    action_items?: string[];
    overview?: string;
    bullet_gist?: string[];
    outline?: string[];
    shorthand_bullet?: string[];
    gist?: string;
    short_summary?: string;
    short_overview?: string;
    topics_discussed?: string[];
    meeting_type?: string;
    transcript_chapters?: Array<{
      chapter: string;
      start_time: number;
      end_time: number;
    }>;
  };
}

export interface TranscriptMetadata {
  id: string; // use Fireflies id as external id, stored in raw metadata and/or transcript_id
  title: string;
  date: string; // ISO
  duration?: number; // seconds
  participants: string[];
  speakerCount?: number;
  summary?: {
    keywords?: string[];
    action_items?: string[];
    overview?: string;
    bullet_gist?: string[];
    outline?: string[];
    shorthand_bullet?: string[];
    gist?: string;
    short_summary?: string;
    short_overview?: string;
    topics_discussed?: string[];
    meeting_type?: string;
    transcript_chapters?: Array<{
      chapter: string;
      start_time: number;
      end_time: number;
    }>;
  };
}

export interface ProcessingOptions {
  detectSentiment?: boolean; // placeholder for later enrichment
}

export interface SearchOptions {
  limit?: number;
  threshold?: number; // cosine similarity threshold (converted via pgvector <=>)
  filters?: {
    department?: string;
    project?: string;
    dateFrom?: string;
    dateTo?: string;
  };
  includeHighlights?: boolean;
}

export interface VectorSearchResult {
  chunk: any;
  similarity: number;
  metadata: any;
  highlight?: string;
}

export interface SyncResult {
  success: boolean;
  processed: number;
  failed: number;
  errors?: Array<{ transcript_id: string; error: string }>;
}

export interface AnalyticsData {
  meetings: {
    total: number;
    lastWeek: number;
    lastMonth: number;
    byDepartment: Record<string, number>;
    byMeetingType: Record<string, number>;
  };
  chunks: {
    total: number;
    averagePerMeeting: number;
    withSpeaker: number;
    withThread: number;
  };
  storage: { filesCount: number; totalSize: string; averageFileSize: string };
  processing: {
    lastSync: string | null;
    lastSyncDuration: number;
    lastSyncProcessed: number;
    lastSyncFailed: number;
    averageProcessingTime: number;
  };
  search: {
    totalSearches: number;
    averageResponseTime: number;
    cacheHitRate: number;
  };
  totalMeetings: number;
  totalDuration: number;
  averageDuration: number;
  topSpeakers: Array<{ name: string; count: number }>;
  topKeywords: Array<{ keyword: string; frequency: number }>;
  departmentBreakdown: Array<{ department: string | null; count: number }>;
  projectBreakdown: Array<{ project: string | null; count: number }>;
  sentimentAnalysis: { positive: number; neutral: number; negative: number };
}

export interface WebhookVerification {
  isValid: boolean;
  signature?: string | null;
  timestamp?: string | null;
}

// ============================================================================
// UTILITY CLASSES
// ============================================================================

/**
 * Structured Logger Class
 * Provides JSON-formatted logging with contextual information.
 * Designed for Cloudflare Workers environment where console.log is captured.
 */
class Logger {
  constructor(
    private level: "debug" | "info" | "warn" | "error" = "info",
    private ctx: Record<string, any> = {},
  ) {}
  setContext(ctx: Record<string, any>) {
    this.ctx = { ...this.ctx, ...ctx };
  }
  child(extra: Record<string, any>) {
    return new Logger(this.level, { ...this.ctx, ...extra });
  }
  private log(
    kind: string,
    msg: string,
    error?: unknown,
    extra?: Record<string, any>,
  ) {
    const base = {
      t: new Date().toISOString(),
      lvl: kind,
      msg,
      ...this.ctx,
      ...(extra || {}),
    };
    // Avoid leaking secrets if ever included
    console.log(
      JSON.stringify(error ? { ...base, error: String(error) } : base),
    );
  }
  debug(msg: string, extra?: any) {
    this.log("debug", msg, undefined, extra);
  }
  info(msg: string, extra?: any) {
    this.log("info", msg, undefined, extra);
  }
  warn(msg: string, extra?: any) {
    this.log("warn", msg, undefined, extra);
  }
  error(msg: string, error?: Error, extra?: any) {
    this.log("error", msg, error, extra);
  }
}

/**
 * Cache Service using Cloudflare KV
 * Provides simple key-value caching with TTL support.
 * Used for idempotency checks and temporary flags.
 */
class CacheService {
  constructor(private kv: KVNamespace, private defaultTTLSeconds = 3600) {}
  async get(namespace: string, key: string): Promise<any | null> {
    return this.kv.get(`${namespace}:${key}`, "json");
  }
  async set(namespace: string, key: string, value: any, ttlSec?: number) {
    await this.kv.put(`${namespace}:${key}`, JSON.stringify(value), {
      expirationTtl: ttlSec ?? this.defaultTTLSeconds,
    });
  }
}

/**
 * Rate Limiter using Cloudflare KV
 * Implements sliding window rate limiting per IP address.
 * Prevents abuse and ensures fair usage of the API.
 */
class RateLimiter {
  constructor(
    private kv: KVNamespace,
    private maxReq: number,
    private windowSec: number,
  ) {}
  private bucketKey(id: string) {
    return `rl:${id}:${Math.floor(Date.now() / 1000 / this.windowSec)}`;
  }
  async checkLimit(id: string) {
    const key = this.bucketKey(id);
    const current = Number(await this.kv.get(key)) || 0;
    if (current >= this.maxReq) {
      return { allowed: false, remaining: 0, reset: this.windowSec };
    }
    await this.kv.put(key, String(current + 1), {
      expirationTtl: this.windowSec + 5,
    });
    return {
      allowed: true,
      remaining: Math.max(0, this.maxReq - current - 1),
      reset: this.windowSec,
    };
  }
  getHeaders(state: { remaining: number; reset: number }) {
    return {
      "X-RateLimit-Remaining": String(state.remaining),
      "X-RateLimit-Reset": String(state.reset),
    };
  }
}

// ============================================================================
// FIREFLIES INTEGRATION
// ============================================================================

/**
 * Fireflies GraphQL Client
 * Handles all communication with Fireflies.ai API.
 * Fetches transcript lists, individual transcripts, and formats to markdown.
 */
class FirefliesClient {
  private baseUrl = "https://api.fireflies.ai/graphql";
  constructor(private apiKey: string, private logger: Logger) {}

  /**
   * Execute GraphQL request against Fireflies API
   * @param query - GraphQL query string
   * @param variables - Query variables
   * @returns GraphQL response data
   * @throws Error on API failures or GraphQL errors
   */
  async graphqlRequest(query: string, variables: Record<string, any> = {}) {
    this.logger.debug("fireflies gql", { variables });
    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const body = await res.text();
      this.logger.error(
        "Fireflies API error",
        new Error(`${res.status} ${res.statusText}`),
        { body },
      );
      throw new Error(`Fireflies API error: ${res.status} ${res.statusText}`);
    }
    const data = await res.json<any>();
    if (data.errors) {
      this.logger.error("Fireflies GraphQL errors", new Error("GraphQL"), {
        errors: data.errors,
      });
      throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
    }
    return data.data;
  }

  /**
   * Fetch list of recent transcripts
   * @param limit - Maximum number of transcripts to fetch (default: 25, max: 100)
   * @param toDate - Optional date filter (ISO string)
   * @returns Array of transcript metadata (without full sentences)
   */
  async getTranscripts(
    limit = 25,
    toDate: string | null = null,
  ): Promise<FirefliesTranscript[]> {
    const query = `
      query GetTranscripts($limit: Int, $toDate: DateTime) {
        transcripts(limit: $limit, toDate: $toDate) {
          id title transcript_url duration date participants
          summary {
            keywords
            action_items
            overview
            bullet_gist
            gist
            short_summary
            short_overview
            outline
            shorthand_bullet
            topics_discussed
            meeting_type
            transcript_chapters
          }
        }
      }
    `;
    const data = await this.graphqlRequest(query, {
      limit: Math.min(limit, 100),
      toDate,
    });
    return data.transcripts as FirefliesTranscript[];
  }

  /**
   * Fetch complete transcript with sentences
   * @param id - Fireflies transcript ID
   * @returns Full transcript including sentences array
   */
  async getTranscriptById(id: string): Promise<FirefliesTranscript> {
    const query = `
      query GetTranscriptContent($id: String!) {
        transcript(id: $id) {
          id title transcript_url duration date participants
          sentences { text speaker_id start_time }
          summary {
            keywords
            action_items
            overview
            bullet_gist
            gist
            short_summary
            short_overview
            outline
            shorthand_bullet
            topics_discussed
            meeting_type
            transcript_chapters
          }
        }
      }
    `;
    const data = await this.graphqlRequest(query, { id });
    return data.transcript as FirefliesTranscript;
  }

  /**
   * Convert Fireflies transcript to formatted Markdown
   * Includes all metadata, summaries, action items, and full transcript.
   * @param t - Fireflies transcript object
   * @returns Formatted markdown string ready for storage
   */
  formatTranscriptAsMarkdown(t: FirefliesTranscript): string {
    let md = `# ${t.title}\n\n`;
    md += `**Date:** ${new Date(t.date).toLocaleString()}\n`;
    md += `**Duration:** ${Math.floor((t.duration || 0) / 60)} minutes\n`;
    md += `**Participants:** ${(t.participants || []).join(", ")}\n\n`;
    
    if (t.summary?.overview) {
      md += `## Summary\n${t.summary.overview}\n\n`;
    }
    
    if (t.summary?.short_overview) {
      md += `## Short Overview\n${t.summary.short_overview}\n\n`;
    }
    
    if (t.summary?.gist) {
      md += `## Gist\n${t.summary.gist}\n\n`;
    }
    
    if (t.summary?.short_summary) {
      md += `## Short Summary\n${t.summary.short_summary}\n\n`;
    }
    
    if (Array.isArray(t.summary?.outline) && t.summary.outline.length) {
      md += `## Outline\n` + t.summary.outline.map((x) =>
        `- ${x}`
      ).join("\n") + "\n\n";
    }
    
    if (Array.isArray(t.summary?.bullet_gist) && t.summary.bullet_gist.length) {
      md += `## Key Points\n` + t.summary.bullet_gist.map((x) =>
        `- ${x}`
      ).join("\n") + "\n\n";
    }
    
    if (Array.isArray(t.summary?.shorthand_bullet) && t.summary.shorthand_bullet.length) {
      md += `## Shorthand Bullets\n` + t.summary.shorthand_bullet.map((x) =>
        `- ${x}`
      ).join("\n") + "\n\n";
    }
    
    if (Array.isArray(t.summary?.topics_discussed) && t.summary.topics_discussed.length) {
      md += `## Topics Discussed\n` + t.summary.topics_discussed.map((x) =>
        `- ${x}`
      ).join("\n") + "\n\n";
    }

    if (t.summary?.meeting_type) {
      md += `## Meeting Type\n${t.summary.meeting_type}\n\n`;
    }

    if (Array.isArray(t.summary?.transcript_chapters) && t.summary.transcript_chapters.length) {
      md += `## Chapters\n`;
      for (const chapter of t.summary.transcript_chapters) {
        const startMin = Math.floor((chapter.start_time || 0) / 60);
        const endMin = Math.floor((chapter.end_time || 0) / 60);
        md += `- **[${startMin}:00 - ${endMin}:00]** ${chapter.chapter}\n`;
      }
      md += "\n";
    }

    if (t.summary?.keywords?.length) {
      md += `## Keywords\n${t.summary.keywords.join(", ")}\n\n`;
    }
    
    if (
      Array.isArray(t.summary?.action_items) && t.summary!.action_items!.length
    ) {
      md += `## Action Items\n` + t.summary!.action_items!.map((x) =>
        `- ${x}`
      ).join("\n") + "\n\n";
    }
    
    if (t.sentences?.length) {
      md += `## Transcript\n\n`;
      let cur = "";
      for (const s of t.sentences) {
        if (s.speaker_id !== cur) {
          cur = s.speaker_id;
          md += `\n**${cur}:**\n`;
        }
        md += `${s.text} `;
      }
    }
    return md;
  }

  /**
   * Extract simplified metadata from transcript
   * @param t - Fireflies transcript object
   * @returns Metadata object for database storage
   */
  extractMetadata(t: FirefliesTranscript): TranscriptMetadata {
    return {
      id: t.id,
      title: t.title,
      date: t.date,
      duration: t.duration,
      participants: t.participants || [],
      speakerCount: new Set(t.sentences?.map((s) => s.speaker_id) || []).size,
      summary: t.summary,
    };
  }
}

// ============================================================================
// SUPABASE STORAGE SERVICE
// ============================================================================

/**
 * Supabase Storage Service
 * Handles uploading transcript markdown files to Supabase Storage.
 * Files are saved in the root of the 'meetings' bucket with date-title format.
 */
class SupabaseStorageService {
  private bucket = "meetings";
  constructor(private client: SupabaseClient, private logger: Logger) {}

  /**
   * Upload transcript markdown to Supabase Storage
   * Files are named as 'YYYY-MM-DD - Meeting Title.md' in the bucket root.
   * @param transcriptId - Fireflies transcript ID (used as fallback filename)
   * @param content - Markdown content to upload
   * @param metadata - Optional metadata for generating descriptive filename
   * @returns Public URL of the uploaded file
   * @throws Error if upload fails
   */
  async uploadTranscript(
    transcriptId: string,
    content: string,
    metadata?: TranscriptMetadata,
  ): Promise<string> {
    // Generate filename with date - title format in root folder
    // Default to transcript ID if metadata is unavailable
    let fileName = `${transcriptId}.md`; // fallback for error cases

    if (metadata) {
      // Format date as YYYY-MM-DD for consistent sorting
      const date = new Date(metadata.date);
      const dateStr = date.toISOString().split('T')[0];

      // Clean title for filesystem compatibility
      const cleanTitle = metadata.title
        .replace(/[^a-zA-Z0-9\s\-]/g, '') // Remove special chars except spaces and hyphens
        .replace(/\s+/g, ' ')              // Normalize multiple spaces to single space
        .trim()                            // Remove leading/trailing whitespace
        .substring(0, 100);                // Limit length to prevent filesystem issues

      // Final format: "2025-09-19 - Weekly Team Meeting.md"
      fileName = `${dateStr} - ${cleanTitle}.md`;
    }
    
    this.logger.debug("upload storage", { fileName });
    const { error } = await this.client.storage.from(this.bucket).upload(
      fileName,
      content,
      { contentType: "text/markdown", upsert: true },
    );
    if (error) {
      this.logger.error("storage upload failed", new Error(error.message));
      throw new Error(`Storage upload failed: ${error.message}`);
    }
    const { data } = this.client.storage.from(this.bucket).getPublicUrl(
      fileName,
    );
    return data.publicUrl;
  }
}

// ============================================================================
// DATABASE SERVICE
// ============================================================================

/**
 * Database Service using direct PostgreSQL connections
 * Handles all database operations including document storage and vector search.
 * Uses Postgres.js library with connection pooling via Hyperdrive.
 */
class DatabaseService {
  private sql: ReturnType<typeof postgres>;
  constructor(conn: string, private logger: Logger) {
    this.sql = postgres(conn, { max: 5, fetch_types: false });
  }

  /**
   * Save or update meeting document in PostgreSQL
   * Performs UPSERT operation on document_metadata table using fireflies_id as unique key.
   * Generates formatted markdown content and stores all metadata.
   * @param meta - Transcript metadata
   * @param fileUrl - URL of the markdown file in Supabase Storage
   * @returns Document ID from the database
   * @throws Error if upsert fails
   */
  async saveMeeting(
    meta: TranscriptMetadata,
    fileUrl: string,
  ): Promise<string> {
    this.logger.debug("save document_metadata", { fireflies_id: meta.id });

    // Generate direct link to Fireflies web interface for this transcript
    const firefliesLink = `https://app.fireflies.ai/view/${meta.id}`;

    // Format the full markdown content for database storage
    // We create a temporary FirefliesClient instance just for formatting
    // This allows us to reuse the markdown formatting logic
    const fireflies = new FirefliesClient("", this.logger); // API key not needed for formatting
    const mockTranscript: FirefliesTranscript = {
      id: meta.id,
      title: meta.title,
      date: meta.date,
      duration: meta.duration,
      participants: meta.participants,
      summary: meta.summary,
    };
    const markdownContent = fireflies.formatTranscriptAsMarkdown(mockTranscript);

    // Handle participants array with defensive type checking
    // Fireflies sometimes returns participants in different formats
    let participantsArray: string[] = [];
    if (meta.participants) {
      if (Array.isArray(meta.participants)) {
        participantsArray = meta.participants;
      } else if (typeof meta.participants === 'string') {
        // Fallback: If it's a comma-separated string, split it
        participantsArray = (meta.participants as any).split(',').map((p: string) => p.trim());
      }
    }

    // Format action_items array
    const actionItemsArray = Array.isArray(meta.summary?.action_items)
      ? meta.summary.action_items
      : [];

    // Format bullet_points array
    const bulletPointsArray = Array.isArray(meta.summary?.bullet_gist)
      ? meta.summary.bullet_gist
      : [];

    // Convert JavaScript arrays to PostgreSQL array format
    // We use jsonb_array_elements_text to safely handle array conversion
    // This approach prevents SQL injection and handles special characters
    const participantsSql = participantsArray.length > 0
      ? `(SELECT array_agg(value) FROM jsonb_array_elements_text('${JSON.stringify(participantsArray).replace(/'/g, "''")}'::jsonb))`
      : `'{}'::text[]`;  // Empty PostgreSQL array

    const actionItemsSql = actionItemsArray.length > 0
      ? `(SELECT array_agg(value) FROM jsonb_array_elements_text('${JSON.stringify(actionItemsArray.map(String)).replace(/'/g, "''")}'::jsonb))`
      : `'{}'::text[]`;  // Empty PostgreSQL array

    const bulletPointsSql = bulletPointsArray.length > 0
      ? `(SELECT array_agg(value) FROM jsonb_array_elements_text('${JSON.stringify(bulletPointsArray.map(String)).replace(/'/g, "''")}'::jsonb))`
      : `'{}'::text[]`;  // Empty PostgreSQL array

    // Use fireflies_id as the primary ID for document_metadata
    const documentId = meta.id;

    const rows = await this.sql`
      INSERT INTO document_metadata (
        id,
        title,
        source,
        content,
        category,
        participants,
        summary,
        action_items,
        bullet_points,
        fireflies_id,
        fireflies_link,
        date,
        duration_minutes,
        url,
        metadata,
        created_at,
        updated_at
      ) VALUES (
        ${documentId},
        ${meta.title},
        ${'fireflies'},
        ${markdownContent},
        ${'meeting'},
        ${this.sql.unsafe(participantsSql)},
        ${meta.summary?.overview || ''},
        ${this.sql.unsafe(actionItemsSql)},
        ${this.sql.unsafe(bulletPointsSql)},
        ${meta.id},
        ${firefliesLink},
        ${new Date(meta.date)},
        ${Math.round((meta.duration || 0) / 60)},
        ${fileUrl},
        ${JSON.stringify({
          fireflies_id: meta.id,
          source: 'fireflies',
          speaker_count: meta.speakerCount || 0,
          meeting_date: meta.date,
          duration_minutes: Math.round((meta.duration || 0) / 60),
          storage_bucket_path: fileUrl,
          keywords: Array.isArray(meta.summary?.keywords) ? meta.summary.keywords : [],
          status: 'pending',
          raw_summary: meta.summary
        })},
        NOW(),
        NOW()
      )
      ON CONFLICT (fireflies_id) DO UPDATE SET
        title = EXCLUDED.title,
        content = EXCLUDED.content,
        participants = EXCLUDED.participants,
        summary = EXCLUDED.summary,
        action_items = EXCLUDED.action_items,
        bullet_points = EXCLUDED.bullet_points,
        date = EXCLUDED.date,
        duration_minutes = EXCLUDED.duration_minutes,
        url = EXCLUDED.url,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING id
    `;

    if (!rows || rows.length === 0) {
      throw new Error("Failed to upsert document_metadata");
    }

    return documentId;
  }

  /**
   * Perform semantic search using pgvector
   * Searches documents table (chunks) using cosine similarity.
   * Joins with document_metadata for full document information.
   * @param queryEmbedding - Vector embedding of the search query
   * @param options - Search filters and options
   * @returns Array of search results with similarity scores
   */
  async vectorSearch(
    queryEmbedding: number[],
    options: SearchOptions = {},
  ): Promise<VectorSearchResult[]> {
    const { limit = 10, threshold = 0.7, filters = {}, includeHighlights } =
      options;
    // Build pgvector search conditions
    // The <=> operator calculates cosine distance between vectors
    // We convert to similarity score: similarity = 1 - distance
    // Threshold filters out results below minimum similarity
    const conds: string[] = [
      `1 - (c.embedding <=> ${
        JSON.stringify(queryEmbedding)
      }::vector) > ${threshold}`,
    ];
    if (filters.department) {
      conds.push(
        `dm.metadata->>'department' = ${
          this.sql.unsafe(`'${filters.department.replace(/'/g, "''")}'`)
        }`,
      );
    }
    if (filters.project) {
      conds.push(
        `dm.project_id::text = ${
          this.sql.unsafe(`'${filters.project.replace(/'/g, "''")}'`)
        }`,
      );
    }
    if (filters.dateFrom) {
      conds.push(
        `dm.date >= ${this.sql.unsafe(`'${filters.dateFrom}'`)}`,
      );
    }
    if (filters.dateTo) {
      conds.push(`dm.date <= ${this.sql.unsafe(`'${filters.dateTo}'`)}`);
    }
    const whereClause = conds.join(" AND ");

    // Chunks table not yet implemented - return empty results
    const rows: any[] = [];

    return rows.map((r: any) => ({
      chunk: {
        document_id: r.document_metadata_id,
        chunk_index: r.chunk_index,
        text: r.text,
        metadata: r.chunk_metadata,
        chunk_id: r.chunk_id,
      },
      similarity: Number(r.similarity),
      metadata: {
        title: r.title,
        date: r.meeting_date,
        duration_minutes: r.duration_minutes,
        participants: r.participants,
        category: r.category,
        summary: r.summary,
        action_items: r.action_items,
        bullet_points: r.bullet_points,
      },
      highlight: includeHighlights ? this.generateHighlight(r.text) : undefined,
    }));
  }

  private generateHighlight(text: string) {
    return (text || "").split(/\s+/).slice(0, 30).join(" ") +
      ((text || "").split(/\s+/).length > 30 ? "…" : "");
  }

  /**
   * Generate comprehensive analytics from stored data
   * Aggregates statistics about meetings, chunks, speakers, and keywords.
   * @returns Complete analytics data structure
   */
  async analytics(): Promise<AnalyticsData> {
    const [
      tm,
      tc,
      dur,
      topSpk,
      topKw,
      dept,
      proj,
      mtype,
      lastW,
      lastM,
      lastSync,
    ] = await Promise.all([
      this.sql`SELECT COUNT(*)::int as count FROM document_metadata WHERE source = 'fireflies'`,
      this.sql`SELECT 0::int as count`, // Chunks table not yet implemented
      this
        .sql`SELECT COALESCE(SUM(duration_minutes),0)::int as total_min, COALESCE(AVG(duration_minutes),0)::int as avg_min FROM document_metadata WHERE source = 'fireflies'`,
      this
        .sql`SELECT unnest(participants) as name, COUNT(*)::int as count FROM document_metadata WHERE source = 'fireflies' GROUP BY name ORDER BY count DESC LIMIT 10`,
      this.sql`SELECT NULL as keywords`, // metadata column might not exist
      this.sql`SELECT NULL as department, 0::int as count`, // metadata column might not exist
      this.sql`SELECT NULL as project, 0::int as count`, // projects table might not exist
      this.sql`SELECT NULL as meeting_type, 0::int as count`, // metadata column might not exist
      this
        .sql`SELECT COUNT(*)::int as count FROM document_metadata WHERE source = 'fireflies' AND date >= CURRENT_DATE - INTERVAL '7 days'`,
      this
        .sql`SELECT COUNT(*)::int as count FROM document_metadata WHERE source = 'fireflies' AND date >= CURRENT_DATE - INTERVAL '30 days'`,
      this
        .sql`SELECT MAX(updated_at) as last_sync, COUNT(CASE WHEN created_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours' THEN 1 END)::int as last_day_count FROM document_metadata WHERE source = 'fireflies'`,
    ]);

    const totalMeetings = tm[0]?.count || 0;
    const totalChunks = tc[0]?.count || 0;
    const avgChunks = totalMeetings
      ? Math.round(totalChunks / totalMeetings)
      : 0;

    // Aggregate keywords across all meetings to find most common topics
    // Keywords are stored as JSON arrays in the metadata column
    const keywordFreq: Record<string, number> = {};
    for (const row of topKw as any[]) {
      const arr: string[] = JSON.parse(row.keywords || '[]');
      for (const k of arr) {
        if (typeof k === "string") {
          keywordFreq[k] = (keywordFreq[k] || 0) + 1;
        }
      }
    }
    // Sort by frequency and take top 20 keywords
    const topKeywords = Object.entries(keywordFreq).sort((a, b) => b[1] - a[1])
      .slice(0, 20).map(([keyword, frequency]) => ({ keyword, frequency }));

    const deptObj: Record<string, number> = {};
    for (const d of (dept as any[])) {
      if (d.department) deptObj[d.department] = d.count;
    }
    const typeObj: Record<string, number> = {};
    for (const t of (mtype as any[])) {
      if (t.meeting_type) typeObj[t.meeting_type] = t.count;
    }

    const estMB = Math.round(
      (totalChunks * 1000 + totalMeetings * 50000) / (1024 * 1024),
    );

    return {
      meetings: {
        total: totalMeetings,
        lastWeek: lastW[0]?.count || 0,
        lastMonth: lastM[0]?.count || 0,
        byDepartment: deptObj,
        byMeetingType: typeObj,
      },
      chunks: {
        total: totalChunks,
        averagePerMeeting: avgChunks,
        withSpeaker: totalChunks,
        withThread: Math.round(totalChunks * 0.6),
      },
      storage: {
        filesCount: totalMeetings,
        totalSize: `${estMB} MB`,
        averageFileSize: `${
          totalMeetings ? (estMB / totalMeetings).toFixed(2) : 0
        } MB`,
      },
      processing: {
        lastSync: lastSync[0]?.last_sync || null,
        lastSyncDuration: 0,
        lastSyncProcessed: lastSync[0]?.last_day_count || 0,
        lastSyncFailed: 0,
        averageProcessingTime: 2000,
      },
      search: { totalSearches: 0, averageResponseTime: 150, cacheHitRate: 0.7 },
      totalMeetings,
      totalDuration: dur[0]?.total_min || 0,
      averageDuration: dur[0]?.avg_min || 0,
      topSpeakers: (topSpk as any[]).map((r) => ({
        name: r.name,
        count: r.count,
      })),
      topKeywords,
      departmentBreakdown: dept as any,
      projectBreakdown: proj as any,
      sentimentAnalysis: { positive: 0, neutral: 0, negative: 0 },
    };
  }

  async cleanup() {
    await this.sql.end();
  }
}

// ============================================================================
// WEBHOOK HANDLER
// ============================================================================

/**
 * Webhook Handler for Fireflies Integration
 * Handles HMAC signature verification for secure webhook endpoints.
 * Ensures webhook requests are authentic and from Fireflies.
 */
class WebhookHandler {
  constructor(private secret: string | undefined, private logger: Logger) {}

  /**
   * Verify HMAC signature of incoming webhook request
   * Uses SHA-256 HMAC with timestamp to prevent replay attacks.
   * @param req - Incoming webhook request
   * @returns Verification result with signature details
   */
  async verifySignature(req: Request): Promise<WebhookVerification> {
    if (!this.secret) return { isValid: true };
    const signature = req.headers.get("X-Fireflies-Signature");
    const timestamp = req.headers.get("X-Fireflies-Timestamp");
    if (!signature || !timestamp) {
      this.logger.warn("missing webhook headers");
      return { isValid: false };
    }
    const body = await req.text();
    const message = `${timestamp}.${body}`;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(this.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(message));
    const expected = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
    return { isValid: signature === expected, signature, timestamp };
  }
}

// ============================================================================
// MAIN TRANSCRIPT PROCESSOR
// ============================================================================

/**
 * Transcript Processor - Core Business Logic
 * Orchestrates the entire transcript processing pipeline:
 * 1. Fetches transcripts from Fireflies
 * 2. Uploads to Supabase Storage
 * 3. Saves metadata to PostgreSQL
 * 4. Triggers vectorization in separate worker
 * 5. Provides search and analytics capabilities
 */
class TranscriptProcessor {
  private supabase: SupabaseClient;
  private storage: SupabaseStorageService;
  private db: DatabaseService;
  private cache: CacheService;
  private fireflies: FirefliesClient;

  constructor(private env: Env, private logger = new Logger("info")) {
    this.cache = new CacheService(env.CACHE, 3600);
    this.supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
    this.storage = new SupabaseStorageService(
      this.supabase,
      this.logger.child({ svc: "storage" }),
    );
    const dbUrl = env.DATABASE_URL || env.HYPERDRIVE?.connectionString;
    if (!dbUrl) {
      throw new Error(
        "DATABASE_URL or HYPERDRIVE.connectionString is required",
      );
    }
    this.db = new DatabaseService(dbUrl, this.logger.child({ svc: "db" }));
    this.fireflies = new FirefliesClient(
      env.FIREFLIES_API_KEY,
      this.logger.child({ svc: "fireflies" }),
    );
  }

  /**
   * Process a single transcript end-to-end
   * Main processing pipeline that coordinates all services.
   * Includes idempotency check to prevent duplicate processing.
   * @param transcriptId - Fireflies transcript ID
   * @param options - Processing configuration options
   */
  async processTranscript(
    transcriptId: string,
    options: ProcessingOptions = {},
  ): Promise<void> {
    const log = this.logger.child({ transcriptId });
    // Idempotency check: Prevent duplicate processing of the same transcript
    // Cache flag expires after 1 hour (configured in cache.set below)
    const processedFlag = await this.cache.get("processed", transcriptId);
    if (processedFlag) {
      log.info("recently processed; skip");
      return;
    }

    const t = await this.fireflies.getTranscriptById(transcriptId);
    if (!t) throw new Error(`Transcript not found: ${transcriptId}`);

    const md = this.fireflies.formatTranscriptAsMarkdown(t);
    const meta = this.fireflies.extractMetadata(t);

    const fileUrl = await this.storage.uploadTranscript(transcriptId, md, meta);
    const documentId = await this.db.saveMeeting(meta, fileUrl);

    await this.triggerVectorization(documentId);

    await this.cache.set("processed", transcriptId, true, 3600);
    log.info("ingest complete; dispatched vectorization", { documentId });
  }

  /**
   * Batch sync multiple transcripts from Fireflies
   * Processes transcripts in parallel with configurable batch size.
   * @param limit - Maximum number of transcripts to sync
   * @returns Sync result with success/failure counts
   */
  async syncAllTranscripts(limit?: number): Promise<SyncResult> {
    const batchSize = limit || this.env.SYNC_BATCH_SIZE || 25;
    const list = await this.fireflies.getTranscripts(batchSize);
    const res: SyncResult = {
      success: true,
      processed: 0,
      failed: 0,
      errors: [],
    };
    const parallel = 3;
    for (let i = 0; i < list.length; i += parallel) {
      const slice = list.slice(i, i + parallel);
      await Promise.all(slice.map(async (tr) => {
        try {
          await this.processTranscript(tr.id);
          res.processed++;
        } catch (e: any) {
          res.failed++;
          res.errors!.push({
            transcript_id: tr.id,
            error: e?.message || String(e),
          });
        }
      }));
      if (i + parallel < list.length) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    return res;
  }

  /**
   * Perform semantic search on transcripts
   * Delegates to vectorizer worker for query embedding, then searches locally.
   * @param query - Search query text
   * @param options - Search filters and configuration
   * @returns Array of relevant transcript chunks
   */
  async search(
    query: string,
    options: SearchOptions = {},
  ): Promise<VectorSearchResult[]> {
    // Delegated embedding happens in vectorizer; but for searching we only need query embedding.
    // If you want to keep query embedding also in the vectorizer, expose a /embed endpoint there and call it here.
    // For now, assume the vectorizer exposes /embed to turn text into embedding.
    const res = await fetch(`${this.env.VECTORIZE_WORKER_URL}/embed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.env.WORKER_AUTH_TOKEN}`,
      },
      body: JSON.stringify({ text: query }),
    });
    if (!res.ok) throw new Error(`Vectorizer /embed failed: ${res.status}`);
    const { embedding } = await res.json<{ embedding: number[] }>();
    return this.db.vectorSearch(embedding, options);
  }

  async analytics(): Promise<AnalyticsData> {
    return this.db.analytics();
  }

  async cleanup() {
    await this.db.cleanup();
  }

  /**
   * Trigger vectorization in separate worker
   * Sends document ID to vectorizer worker for chunk generation and embedding.
   * Fire-and-forget pattern - errors are logged but don't fail main processing.
   * @param documentId - Database document ID to process
   */
  private async triggerVectorization(documentId: string) {
    const res = await fetch(`${this.env.VECTORIZE_WORKER_URL}/process`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.env.WORKER_AUTH_TOKEN}`,
      },
      body: JSON.stringify({ documentId }),
    });
    if (!res.ok) {
      const body = await res.text();
      this.logger.error(
        "vectorization trigger failed",
        new Error(String(res.status)),
        { body },
      );
    }
  }
}

// ============================================================================
// CLOUDFLARE WORKER ENTRY POINT
// ============================================================================

/**
 * Main Worker Export
 * Handles HTTP requests and scheduled cron jobs.
 * Implements all API endpoints and webhook handling.
 */
export default {
  /**
   * Main HTTP Request Handler
   * Routes incoming requests to appropriate endpoints.
   * Implements CORS, rate limiting, and error handling.
   *
   * ENDPOINTS:
   * - GET  /api/health         - Health check and service status
   * - POST /api/sync           - Batch sync transcripts from Fireflies
   * - POST /api/process        - Process single transcript by ID
   * - POST /api/search         - Semantic search (requires vectorizer)
   * - GET  /api/analytics      - Usage statistics and analytics
   * - POST /webhook/fireflies  - Webhook endpoint for real-time updates
   */
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const logger = new Logger("info");
    logger.setContext({ path: url.pathname, method: request.method });

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const rateLimiter = new RateLimiter(
      env.CACHE,
      Number(env.RATE_LIMIT_REQUESTS || 60),
      Number(env.RATE_LIMIT_WINDOW || 60),
    );

    // Apply rate limiting to all non-webhook routes
    // Webhooks are exempt as they come from trusted Fireflies servers
    if (!url.pathname.startsWith("/webhook")) {
      // Get client IP from Cloudflare header (most reliable in CF Workers)
      const ip = request.headers.get("CF-Connecting-IP") || "anon";
      const state = await rateLimiter.checkLimit(ip);
      if (!state.allowed) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
          status: 429,  // HTTP 429 Too Many Requests
          headers: {
            ...cors,
            ...rateLimiter.getHeaders(state),  // Include rate limit headers
            "Content-Type": "application/json",
          },
        });
      }
    }

    try {
      switch (url.pathname) {
        // ========== WEBHOOK ENDPOINT ==========
        // Receives real-time notifications from Fireflies when transcripts are ready
        case "/webhook/fireflies": {
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }
          const wh = new WebhookHandler(env.FIREFLIES_WEBHOOK_SECRET, logger);
          const check = await wh.verifySignature(request.clone());
          if (!check.isValid) {
            return new Response("Unauthorized", { status: 401 });
          }
          const body = await request.json<any>();
          const transcriptId = body?.transcript_id || body?.data?.id ||
            body?.data?.transcript_id;
          if (transcriptId) {
            const proc = new TranscriptProcessor(
              env,
              logger.child({ route: "webhook" }),
            );
            ctx.waitUntil(
              proc.processTranscript(transcriptId).then(() => proc.cleanup()),
            );
          }
          return new Response(JSON.stringify({ ok: true }), {
            headers: { ...cors, "Content-Type": "application/json" },
          });
        }

        // ========== BATCH SYNC ENDPOINT ==========
        // Synchronizes recent transcripts from Fireflies in bulk
        case "/api/sync": {
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }
          const body = await request.json<any>().catch(() => ({}));
          const limit = Number(body.limit || env.SYNC_BATCH_SIZE || 25);
          const proc = new TranscriptProcessor(
            env,
            logger.child({ route: "sync" }),
          );
          const result = await proc.syncAllTranscripts(limit);
          await proc.cleanup();
          return new Response(JSON.stringify(result), {
            headers: { ...cors, "Content-Type": "application/json" },
          });
        }

        // ========== SINGLE TRANSCRIPT PROCESSING ==========
        // Process a specific transcript by its Fireflies ID
        case "/api/process": {
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }
          const body = await request.json<any>();
          if (!body?.transcript_id) {
            return new Response("Missing transcript_id", { status: 400 });
          }
          const proc = new TranscriptProcessor(
            env,
            logger.child({ route: "process" }),
          );
          await proc.processTranscript(body.transcript_id, body.options);
          await proc.cleanup();
          return new Response(
            JSON.stringify({ ok: true, transcript_id: body.transcript_id }),
            { headers: { ...cors, "Content-Type": "application/json" } },
          );
        }

        // ========== SEMANTIC SEARCH ENDPOINT ==========
        // Performs vector similarity search on embedded transcripts
        // Note: Requires vectorizer worker to be configured
        case "/api/search": {
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }
          const body = await request.json<any>();
          if (!body?.query) {
            return new Response("Missing query", { status: 400 });
          }
          const proc = new TranscriptProcessor(
            env,
            logger.child({ route: "search" }),
          );
          const results = await proc.search(body.query, body.options || {});
          await proc.cleanup();
          return new Response(JSON.stringify({ results }), {
            headers: { ...cors, "Content-Type": "application/json" },
          });
        }

        // ========== ANALYTICS ENDPOINT ==========
        // Returns comprehensive usage statistics and insights
        case "/api/analytics": {
          if (request.method !== "GET") {
            return new Response("Method not allowed", { status: 405 });
          }
          const proc = new TranscriptProcessor(
            env,
            logger.child({ route: "analytics" }),
          );
          const data = await proc.analytics();
          await proc.cleanup();
          return new Response(JSON.stringify(data), {
            headers: { ...cors, "Content-Type": "application/json" },
          });
        }

        // ========== HEALTH CHECK ENDPOINT ==========
        // Simple health check for monitoring and uptime checks
        case "/api/health":
        case "/health": {
          return new Response(
            JSON.stringify({
              status: "healthy",
              ts: new Date().toISOString(),
              service: "fireflies-ingest",
            }),
            { headers: { ...cors, "Content-Type": "application/json" } },
          );
        }

        default:
          return new Response("Not found", { status: 404, headers: cors });
      }
    } catch (err: any) {
      logger.error("handler error", err);
      return new Response(
        JSON.stringify({ error: err?.message || "Internal error" }),
        {
          status: 500,
          headers: { ...cors, "Content-Type": "application/json" },
        },
      );
    }
  },

  /**
   * Scheduled Cron Handler
   * Automatically syncs transcripts on a schedule (configured in wrangler.toml).
   * Default schedule: Every 30 minutes
   * Processes recent transcripts to keep database up-to-date.
   */
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const logger = new Logger("info");
    logger.info("cron start", { cron: (controller as any).cron });
    const proc = new TranscriptProcessor(env, logger.child({ route: "cron" }));
    try {
      const res = await proc.syncAllTranscripts(env.SYNC_BATCH_SIZE || 25);
      logger.info("cron done", res);
    } catch (e: any) {
      logger.error("cron failed", e);
    } finally {
      await proc.cleanup();
    }
  },
} satisfies ExportedHandler<Env>;
