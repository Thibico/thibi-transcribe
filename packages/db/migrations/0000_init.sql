CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"asset_id" uuid NOT NULL,
	"title" text NOT NULL,
	"language_code" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"primary_run_id" uuid,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_access_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "media_access_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"asset_id" uuid NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"mime" text,
	"bytes" bigint NOT NULL,
	"duration_ms" integer,
	"source" text DEFAULT 'upload' NOT NULL,
	"source_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"probe_raw" jsonb,
	"deleted_at" timestamp with time zone,
	"deleted_reason" text,
	"legal_hold" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_derivatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"recipe_version" text NOT NULL,
	"storage_key" text NOT NULL,
	"bytes" bigint NOT NULL,
	"duration_ms" integer,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"default_language_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"offset_ms" integer NOT NULL,
	"content_start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"overlap_lead_ms" integer DEFAULT 0 NOT NULL,
	"storage_key" text,
	"raw_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" jsonb,
	"bytes" bigint,
	CONSTRAINT "run_chunks_interval" CHECK ("run_chunks"."offset_ms" <= "run_chunks"."content_start_ms" and "run_chunks"."content_start_ms" <= "run_chunks"."end_ms")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"model" text NOT NULL,
	"language_code" text NOT NULL,
	"mode" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"pipeline" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"progress" double precision DEFAULT 0 NOT NULL,
	"word_timing_quality" text,
	"operation_name" text,
	"staging_prefix" text,
	"cost_usd" double precision,
	"engine_version" text NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"error" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_progress_range" CHECK ("runs"."progress" >= 0 and "runs"."progress" <= 1)
);
--> statement-breakpoint
CREATE TABLE "segment_texts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"segment_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"layer" text NOT NULL,
	"target_lang" text DEFAULT '' NOT NULL,
	"origin" text NOT NULL,
	"text" text NOT NULL,
	"pass_id" uuid,
	"author_id" uuid,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"superseded_by" uuid,
	CONSTRAINT "segment_texts_lang" CHECK (("segment_texts"."layer" = 'translated') = ("segment_texts"."target_lang" <> ''))
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"text" text NOT NULL,
	"text_raw" text NOT NULL,
	"confidence" double precision,
	"chunk_id" uuid,
	"has_words" boolean DEFAULT false NOT NULL,
	"speaker_id" uuid,
	"speaker_purity" double precision,
	"needs_speaker_review" boolean DEFAULT false NOT NULL,
	"split_of" uuid,
	"superseded_at" timestamp with time zone,
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segments_interval" CHECK ("segments"."start_ms" <= "segments"."end_ms")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"secret_ct" "bytea",
	"nonce" "bytea",
	"tag" "bytea",
	"is_secret" boolean DEFAULT false NOT NULL,
	"hint" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "words" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "words_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"segment_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"text" text NOT NULL,
	"confidence" double precision,
	"speaker_id" uuid,
	"is_estimated" boolean DEFAULT false NOT NULL,
	CONSTRAINT "words_interval" CHECK ("words"."start_ms" <= "words"."end_ms")
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_access_log" ADD CONSTRAINT "media_access_log_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_derivatives" ADD CONSTRAINT "media_derivatives_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_chunks" ADD CONSTRAINT "run_chunks_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_texts" ADD CONSTRAINT "segment_texts_segment_id_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_texts" ADD CONSTRAINT "segment_texts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_chunk_id_run_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."run_chunks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "words" ADD CONSTRAINT "words_segment_id_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "words" ADD CONSTRAINT "words_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_project_created" ON "jobs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_status" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "jobs_asset" ON "jobs" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "media_access_log_asset_at" ON "media_access_log" USING btree ("asset_id","at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_sha256" ON "media_assets" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "media_derivatives_key" ON "media_derivatives" USING btree ("asset_id","kind","recipe_version");--> statement-breakpoint
CREATE INDEX "media_derivatives_asset" ON "media_derivatives" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug" ON "projects" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "run_chunks_run_idx" ON "run_chunks" USING btree ("run_id","idx");--> statement-breakpoint
CREATE INDEX "run_chunks_run_status" ON "run_chunks" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "runs_job_created" ON "runs" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_state" ON "runs" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "segment_texts_live" ON "segment_texts" USING btree ("segment_id","layer","target_lang") WHERE "segment_texts"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "segment_texts_run_layer" ON "segment_texts" USING btree ("run_id","layer","target_lang") WHERE "segment_texts"."superseded_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "segments_run_idx_live" ON "segments" USING btree ("run_id","idx") WHERE "segments"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "segments_run_start" ON "segments" USING btree ("run_id","start_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "words_segment_idx" ON "words" USING btree ("segment_id","idx");--> statement-breakpoint
CREATE INDEX "words_run_start" ON "words" USING btree ("run_id","start_ms");--> statement-breakpoint
CREATE INDEX "words_low_conf" ON "words" USING btree ("run_id","start_ms") WHERE "words"."confidence" < 0.5;