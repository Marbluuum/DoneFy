CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'paused' NOT NULL,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"post_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"flow" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"public_identifier" text NOT NULL,
	"full_name" text,
	"headline" text,
	"company" text,
	"degree" integer,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"opted_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"post_id" uuid,
	"state" text DEFAULT 'detected' NOT NULL,
	"comment_urn" text,
	"comment_text" text,
	"matched_keyword" text,
	"next_action_at" timestamp with time zone,
	"invited_at" timestamp with time zone,
	"entered_state_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"enrollment_id" uuid,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"enrollment_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"leased_until" timestamp with time zone,
	"leased_by" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "linkedin_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"public_identifier" text NOT NULL,
	"display_name" text,
	"is_premium" integer DEFAULT 0 NOT NULL,
	"agent_last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"enrollment_id" uuid,
	"channel" text NOT NULL,
	"direction" text NOT NULL,
	"body" text NOT NULL,
	"generated" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"urn" text NOT NULL,
	"url" text NOT NULL,
	"excerpt" text,
	"posted_at" timestamp with time zone,
	"last_scanned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quota_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"day" text NOT NULL,
	"action" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_account_id_linkedin_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."linkedin_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_account_id_linkedin_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."linkedin_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_account_id_linkedin_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."linkedin_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_account_id_linkedin_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."linkedin_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_accounts" ADD CONSTRAINT "linkedin_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_account_id_linkedin_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."linkedin_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_usage" ADD CONSTRAINT "quota_usage_account_id_linkedin_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."linkedin_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_account_identifier_idx" ON "contacts" USING btree ("account_id","public_identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "enrollments_automation_contact_idx" ON "enrollments" USING btree ("automation_id","contact_id");--> statement-breakpoint
CREATE INDEX "enrollments_due_idx" ON "enrollments" USING btree ("state","next_action_at");--> statement-breakpoint
CREATE INDEX "events_account_created_idx" ON "events" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("account_id","status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "linkedin_accounts_user_identifier_idx" ON "linkedin_accounts" USING btree ("user_id","public_identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "posts_account_urn_idx" ON "posts" USING btree ("account_id","urn");--> statement-breakpoint
CREATE UNIQUE INDEX "quota_usage_account_day_action_idx" ON "quota_usage" USING btree ("account_id","day","action");