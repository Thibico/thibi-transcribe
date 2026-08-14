CREATE TYPE "public"."step_state" AS ENUM('pending', 'ready', 'running', 'awaiting_external', 'done', 'skipped', 'failed', 'dead', 'cancelled');--> statement-breakpoint
CREATE TABLE "rate_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"capacity" double precision NOT NULL,
	"refill_per_s" double precision NOT NULL,
	"tokens" double precision NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "run_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ordinal" integer NOT NULL,
	"shard" integer DEFAULT -1 NOT NULL,
	"queue" text NOT NULL,
	"depends_on" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"optional" boolean DEFAULT false NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"state" "step_state" DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"error" jsonb,
	"external_ref" text,
	"poll_after" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"lease_owner" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "segments" ADD COLUMN "placeholder_reason" text;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_events_run_seq" ON "run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_run_kind_shard" ON "run_steps" USING btree ("run_id","kind","shard");--> statement-breakpoint
CREATE INDEX "run_steps_run_ordinal" ON "run_steps" USING btree ("run_id","ordinal");--> statement-breakpoint
CREATE INDEX "run_steps_live" ON "run_steps" USING btree ("state") WHERE "run_steps"."state" in ('ready', 'running', 'awaiting_external');--> statement-breakpoint
CREATE INDEX "run_steps_poll" ON "run_steps" USING btree ("poll_after") WHERE "run_steps"."state" = 'awaiting_external';--> statement-breakpoint
CREATE INDEX "run_steps_hb" ON "run_steps" USING btree ("heartbeat_at") WHERE "run_steps"."state" = 'running';--> statement-breakpoint
CREATE INDEX "run_steps_dead" ON "run_steps" USING btree ("finished_at" DESC NULLS LAST) WHERE "run_steps"."state" = 'dead';