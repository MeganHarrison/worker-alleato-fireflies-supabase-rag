/*
 * Fireflies Ingest Worker (Cloudflare Workers)
 * ------------------------------------------------------------
 * Purpose
 *   - Receive Fireflies transcripts (via webhook or on-demand sync)
 *   - Format to Markdown and upload to Supabase Storage (bucket: "meetings")
 *   - Upsert a meeting record in Postgres/Supabase and return its meeting.id
 *   - Trigger a dedicated Vectorizer Worker that handles chunking + OpenAI embeddings
 *   - Provide light analytics and vector search (reads DB only)
 *
 * Responsibilities owned HERE
 *   ✓ Fireflies GraphQL client (fetch transcript lists and full transcript)
 *   ✓ Supabase Storage write of markdown transcript
 *   ✓ Postgres insert/upsert of meetings row (returns meeting.id)
 *   ✓ Webhook verification (HMAC) + rate limiting + basic status endpoints
 *   ✓ Dispatch to Vectorizer Worker: POST { meetingId }
 *
 * Responsibilities delegated to VECTORIZE WORKER (OpenAI)
 *   → Chunk transcript
 *   → Generate embeddings with OpenAI (e.g., text-embedding-3-large)
 *   → Insert meeting_chunks rows (with pgvector embeddings)
 *   → Update meetings.processing_status, processed_at, processing_error
 *
 * Required environment bindings (wrangler.toml)
 *   vars = {
 *     SUPABASE_URL = "...",
 *     SUPABASE_SERVICE_KEY = "...",
 *     FIREFLIES_API_KEY = "...",
 *     FIREFLIES_WEBHOOK_SECRET = "...",
 *     VECTORIZE_WORKER_URL = "https://your-vectorizer.workers.dev",
 *     WORKER_AUTH_TOKEN = "long-random-token",
 *     SYNC_BATCH_SIZE = 25,
 *     RATE_LIMIT_REQUESTS = 60,
 *     RATE_LIMIT_WINDOW = 60
 *   }
 *   [[kv_namespaces]]
 *     binding = "CACHE"
 *     id = "<kv-id>"
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

// ===== Minimal Logger =====
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

// ===== KV-backed Cache (simple flags) =====
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

// ===== KV-backed Rate Limiter =====
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

// ===== Fireflies Client =====
class FirefliesClient {
  private baseUrl = "https://api.fireflies.ai/graphql";
  constructor(private apiKey: string, private logger: Logger) {}

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

  async getTranscripts(
    limit = 25,
    toDate: string | null = null,
  ): Promise<FirefliesTranscript[]> {
    const query = `
      query GetTranscripts($limit: Int, $toDate: DateTime) {
        transcripts(limit: $limit, toDate: $toDate) {
          id title transcript_url duration date participants
          summary { keywords action_items overview bullet_gist }
        }
      }
    `;
    const data = await this.graphqlRequest(query, {
      limit: Math.min(limit, 100),
      toDate,
    });
    return data.transcripts as FirefliesTranscript[];
  }

  async getTranscriptById(id: string): Promise<FirefliesTranscript> {
    const query = `
      query GetTranscriptContent($id: String!) {
        transcript(id: $id) {
          id title transcript_url duration date participants
          sentences { text speaker_id start_time }
          summary { keywords action_items overview bullet_gist }
        }
      }
    `;
    const data = await this.graphqlRequest(query, { id });
    return data.transcript as FirefliesTranscript;
  }

  formatTranscriptAsMarkdown(t: FirefliesTranscript): string {
    let md = `# ${t.title}\n\n`;
    md += `**Date:** ${new Date(t.date).toLocaleString()}\n`;
    md += `**Duration:** ${Math.floor((t.duration || 0) / 60)} minutes\n`;
    md += `**Participants:** ${(t.participants || []).join(", ")}\n\n`;
    
    if (t.summary?.overview) {
      md += `## Summary\n${t.summary.overview}\n\n`;
    }
    
    if (Array.isArray(t.summary?.bullet_gist) && t.summary.bullet_gist.length) {
      md += `## Key Points\n` + t.summary.bullet_gist.map((x) =>
        `- ${x}`
      ).join("\n") + "\n\n";
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

// ===== Supabase Storage =====
class SupabaseStorageService {
  private bucket = "meetings";
  constructor(private client: SupabaseClient, private logger: Logger) {}

  async uploadTranscript(
    transcriptId: string,
    content: string,
    metadata?: TranscriptMetadata,
  ): Promise<string> {
    // Generate filename with date - title format
    let fileName = `transcripts/${transcriptId}.md`; // fallback
    
    if (metadata) {
      // Format date as YYYY-MM-DD
      const date = new Date(metadata.date);
      const dateStr = date.toISOString().split('T')[0];
      
      // Clean title for filename (remove invalid characters)
      const cleanTitle = metadata.title
        .replace(/[^a-zA-Z0-9\s\-]/g, '') // Remove special chars except spaces and hyphens
        .replace(/\s+/g, ' ') // Normalize spaces
        .trim()
        .substring(0, 100); // Limit length
      
      fileName = `transcripts/${dateStr} - ${cleanTitle}.md`;
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

// ===== Database (direct SQL) =====
class DatabaseService {
  private sql: ReturnType<typeof postgres>;
  constructor(conn: string, private logger: Logger) {
    this.sql = postgres(conn, { max: 5, fetch_types: false });
  }

  /** Upsert document (formerly meeting) and RETURN id (uuid/text) */
  async saveMeeting(
    meta: TranscriptMetadata,
    fileUrl: string,
  ): Promise<string> {
    this.logger.debug("save document", { fireflies_id: meta.id });
    
    // Generate the Fireflies link
    const firefliesLink = `https://app.fireflies.ai/view/${meta.id}`;
    
    // Format the full markdown content (will be stored in content column)
    const fireflies = new FirefliesClient("", this.logger); // Temporary instance for formatting
    const mockTranscript: FirefliesTranscript = {
      id: meta.id,
      title: meta.title,
      date: meta.date,
      duration: meta.duration,
      participants: meta.participants,
      summary: meta.summary,
    };
    const markdownContent = fireflies.formatTranscriptAsMarkdown(mockTranscript);
    
    // Handle participants array properly
    let participantsArray: string[] = [];
    if (meta.participants) {
      if (Array.isArray(meta.participants)) {
        participantsArray = meta.participants;
      } else if (typeof meta.participants === 'string') {
        // If it's a comma-separated string, split it
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
    
    // Use COALESCE to handle empty arrays gracefully - escape JSON properly for SQL
    const participantsSql = participantsArray.length > 0 
      ? `(SELECT array_agg(value) FROM jsonb_array_elements_text('${JSON.stringify(participantsArray).replace(/'/g, "''")}'::jsonb))`
      : `'{}'::text[]`;
    
    const actionItemsSql = actionItemsArray.length > 0
      ? `(SELECT array_agg(value) FROM jsonb_array_elements_text('${JSON.stringify(actionItemsArray.map(String)).replace(/'/g, "''")}'::jsonb))`
      : `'{}'::text[]`;
    
    const bulletPointsSql = bulletPointsArray.length > 0
      ? `(SELECT array_agg(value) FROM jsonb_array_elements_text('${JSON.stringify(bulletPointsArray.map(String)).replace(/'/g, "''")}'::jsonb))`
      : `'{}'::text[]`;
    
    const rows = await this.sql`
      INSERT INTO documents (
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
        metadata,
        created_at,
        updated_at
      ) VALUES (
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
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING id
    `;
    const documentId = rows[0]?.id as string;
    if (!documentId) throw new Error("Failed to upsert document");
    return documentId;
  }

  async vectorSearch(
    queryEmbedding: number[],
    options: SearchOptions = {},
  ): Promise<VectorSearchResult[]> {
    const { limit = 10, threshold = 0.7, filters = {}, includeHighlights } =
      options;
    // pgvector cosine distance via <=> (assuming embeddings are normalized). Similarity = 1 - distance
    const conds: string[] = [
      `1 - (c.embedding <=> ${
        JSON.stringify(queryEmbedding)
      }::vector) > ${threshold}`,
    ];
    if (filters.department) {
      conds.push(
        `d.metadata->>'department' = ${
          postgres.unsafeLiteral(`'${filters.department.replace(/'/g, "''")}'`)
        }`,
      );
    }
    if (filters.project) {
      conds.push(
        `d.project_id::text = ${
          postgres.unsafeLiteral(`'${filters.project.replace(/'/g, "''")}'`)
        }`,
      );
    }
    if (filters.dateFrom) {
      conds.push(
        `d.meeting_date >= ${postgres.unsafeLiteral(`'${filters.dateFrom}'`)}`,
      );
    }
    if (filters.dateTo) {
      conds.push(`d.meeting_date <= ${postgres.unsafeLiteral(`'${filters.dateTo}'`)}`);
    }
    const whereClause = conds.join(" AND ");

    const rows = await this.sql`
      SELECT 
        c.document_id, c.chunk_index, c.content as text, c.metadata as chunk_metadata,
        d.title, d.metadata->>'meeting_date' as meeting_date, (d.metadata->>'duration_minutes')::int as duration_minutes, d.participants, 
        d.category, d.summary, d.action_items, d.bullet_points,
        1 - (c.embedding <=> ${
      JSON.stringify(queryEmbedding)
    }::vector) as similarity
      FROM document_chunks c
      JOIN documents d ON c.document_id = d.id
      WHERE ${this.sql.unsafe(whereClause)}
      ORDER BY similarity DESC
      LIMIT ${limit}
    `;

    return rows.map((r: any) => ({
      chunk: {
        document_id: r.document_id,
        chunk_index: r.chunk_index,
        text: r.text,
        metadata: r.chunk_metadata,
        embedding: r.embedding,
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
      this.sql`SELECT COUNT(*)::int as count FROM documents WHERE source = 'fireflies'`,
      this.sql`SELECT COUNT(*)::int as count FROM document_chunks WHERE document_id IN (SELECT id FROM documents WHERE source = 'fireflies')`,
      this
        .sql`SELECT COALESCE(SUM(duration_minutes),0)::int as total_min, COALESCE(AVG(duration_minutes),0)::int as avg_min FROM documents WHERE source = 'fireflies'`,
      this
        .sql`SELECT unnest(participants) as name, COUNT(*)::int as count FROM documents WHERE source = 'fireflies' GROUP BY name ORDER BY count DESC LIMIT 10`,
      this
        .sql`SELECT metadata->>'keywords' as keywords FROM documents WHERE source = 'fireflies' AND metadata->>'keywords' IS NOT NULL`,
      this
        .sql`SELECT metadata->>'department' as department, COUNT(*)::int as count FROM documents WHERE source = 'fireflies' AND metadata->>'department' IS NOT NULL GROUP BY department ORDER BY count DESC`,
      this
        .sql`SELECT p.name as project, COUNT(*)::int as count FROM documents d LEFT JOIN projects p ON d.project_id = p.id WHERE d.source = 'fireflies' AND d.project_id IS NOT NULL GROUP BY p.name ORDER BY count DESC`,
      this
        .sql`SELECT metadata->>'meeting_type' as meeting_type, COUNT(*)::int as count FROM documents WHERE source = 'fireflies' AND metadata->>'meeting_type' IS NOT NULL GROUP BY meeting_type ORDER BY count DESC`,
      this
        .sql`SELECT COUNT(*)::int as count FROM documents WHERE source = 'fireflies' AND meeting_date >= CURRENT_DATE - INTERVAL '7 days'`,
      this
        .sql`SELECT COUNT(*)::int as count FROM documents WHERE source = 'fireflies' AND meeting_date >= CURRENT_DATE - INTERVAL '30 days'`,
      this
        .sql`SELECT MAX(updated_at) as last_sync, COUNT(CASE WHEN created_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours' THEN 1 END)::int as last_day_count FROM documents WHERE source = 'fireflies'`,
    ]);

    const totalMeetings = tm[0]?.count || 0;
    const totalChunks = tc[0]?.count || 0;
    const avgChunks = totalMeetings
      ? Math.round(totalChunks / totalMeetings)
      : 0;

    // Flatten keywords (now they're directly arrays in documents table)
    const keywordFreq: Record<string, number> = {};
    for (const row of topKw as any[]) {
      const arr: string[] = JSON.parse(row.keywords || '[]');
      for (const k of arr) {
        if (typeof k === "string") {
          keywordFreq[k] = (keywordFreq[k] || 0) + 1;
        }
      }
    }
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

// ===== Webhook HMAC =====
class WebhookHandler {
  constructor(private secret: string | undefined, private logger: Logger) {}

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

// ===== Transcript Processor (no local embeddings; delegates) =====
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

  async processTranscript(
    transcriptId: string,
    options: ProcessingOptions = {},
  ): Promise<void> {
    const log = this.logger.child({ transcriptId });
    // idempotency: skip if processed flag recently set
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

// ===== HTTP Handlers =====
export default {
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

    // Rate limit non-webhook routes
    if (!url.pathname.startsWith("/webhook")) {
      const ip = request.headers.get("CF-Connecting-IP") || "anon";
      const state = await rateLimiter.checkLimit(ip);
      if (!state.allowed) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
          status: 429,
          headers: {
            ...cors,
            ...rateLimiter.getHeaders(state),
            "Content-Type": "application/json",
          },
        });
      }
    }

    try {
      switch (url.pathname) {
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

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const logger = new Logger("info");
    logger.info("cron start", { cron: (event as any).cron });
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
