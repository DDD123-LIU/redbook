PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS content (
  content_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  source_content_id TEXT NOT NULL,
  source_url_ref TEXT,
  author_id TEXT,
  author_name TEXT,
  source_state TEXT NOT NULL CHECK (source_state IN ('available','unavailable','unknown','removed','source_deleted','temporarily_unavailable','access_blocked')),
  last_observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(platform, source_content_id)
);
CREATE TRIGGER IF NOT EXISTS content_identity_immutable BEFORE UPDATE ON content
WHEN NEW.content_id IS NOT OLD.content_id OR NEW.platform IS NOT OLD.platform OR NEW.source_content_id IS NOT OLD.source_content_id
BEGIN SELECT RAISE(ABORT, 'content identity is immutable'); END;

CREATE TABLE IF NOT EXISTS collection_batch (
  collection_batch_id TEXT PRIMARY KEY,
  observed_from TEXT NOT NULL,
  observed_until TEXT NOT NULL,
  coverage_json TEXT NOT NULL,
  total_count INTEGER CHECK (total_count IS NULL OR total_count >= 0),
  total_known INTEGER NOT NULL CHECK (total_known IN (0,1)),
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_observation (
  collection_observation_id TEXT PRIMARY KEY,
  collection_batch_id TEXT NOT NULL REFERENCES collection_batch(collection_batch_id),
  content_id TEXT NOT NULL REFERENCES content(content_id),
  observed_at TEXT NOT NULL,
  membership TEXT NOT NULL CHECK (membership IN ('present','confirmed_removed','unknown')),
  evidence_ref TEXT NOT NULL,
  collected_at TEXT,
  coverage_ref TEXT,
  UNIQUE(collection_batch_id, content_id, observed_at)
);

CREATE TABLE IF NOT EXISTS material_version (
  material_version_id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL REFERENCES content(content_id),
  body_ref TEXT,
  body_hash TEXT,
  ordered_images_json TEXT NOT NULL DEFAULT '[]',
  cover_ref TEXT,
  cover_hash TEXT,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('image','video','text','unknown')),
  published_at TEXT,
  fetched_at TEXT NOT NULL,
  material_hash TEXT NOT NULL,
  completeness TEXT NOT NULL CHECK (completeness IN ('complete','partial','video_unread','failed','unknown')),
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  fetch_status TEXT NOT NULL CHECK (fetch_status IN ('succeeded','failed','unknown','blocked')),
  repair_of_material_version_id TEXT REFERENCES material_version(material_version_id),
  artifact_hash TEXT,
  CHECK ((repair_of_material_version_id IS NULL AND artifact_hash IS NULL) OR
    (repair_of_material_version_id IS NOT NULL AND artifact_hash IS NOT NULL AND length(artifact_hash)=64 AND artifact_hash NOT GLOB '*[^a-f0-9]*'))
);
CREATE UNIQUE INDEX IF NOT EXISTS material_success_hash_uq ON material_version(content_id, material_hash)
  WHERE fetch_status='succeeded' AND repair_of_material_version_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS material_repair_artifact_uq ON material_version(content_id, material_hash, artifact_hash)
  WHERE fetch_status='succeeded' AND repair_of_material_version_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS material_repair_insert_validate BEFORE INSERT ON material_version
WHEN (NEW.repair_of_material_version_id IS NULL AND NEW.artifact_hash IS NOT NULL)
  OR (NEW.repair_of_material_version_id IS NOT NULL AND (
    NEW.fetch_status<>'succeeded' OR NEW.artifact_hash IS NULL OR length(NEW.artifact_hash)<>64
    OR NEW.artifact_hash GLOB '*[^a-f0-9]*' OR NOT EXISTS (
      SELECT 1 FROM material_version parent
      WHERE parent.material_version_id=NEW.repair_of_material_version_id
        AND parent.content_id=NEW.content_id AND parent.material_hash=NEW.material_hash
        AND parent.media_kind=NEW.media_kind AND parent.completeness=NEW.completeness
        AND parent.fetch_status='succeeded' AND parent.repair_of_material_version_id IS NULL
    )
  ))
BEGIN SELECT RAISE(ABORT, 'invalid material repair parent or artifact hash'); END;

CREATE TABLE IF NOT EXISTS analysis (
  analysis_id TEXT PRIMARY KEY,
  material_version_id TEXT NOT NULL REFERENCES material_version(material_version_id),
  input_hash TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model_requested TEXT NOT NULL,
  model_observed TEXT,
  output_ref TEXT,
  completion_evidence TEXT,
  status TEXT NOT NULL CHECK (status IN ('complete','partial','failed','blocked','unknown')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS analysis_complete_lookup_idx ON analysis(material_version_id,input_hash,prompt_version,created_at DESC,analysis_id) WHERE status='complete';

CREATE TABLE IF NOT EXISTS preference_version (
  preference_version TEXT PRIMARY KEY,
  parent_version TEXT REFERENCES preference_version(preference_version),
  explicit_instructions_json TEXT NOT NULL DEFAULT '[]',
  supporting_content_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(supporting_content_ids_json) AND json_type(supporting_content_ids_json)='array'),
  hypotheses_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL,
  counterexamples_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS preference_support_ids_guard BEFORE INSERT ON preference_version
WHEN EXISTS (SELECT 1 FROM json_each(NEW.supporting_content_ids_json) WHERE type<>'text' OR length(value)=0)
BEGIN SELECT RAISE(ABORT, 'supporting content ids must be non-empty text'); END;
CREATE TABLE IF NOT EXISTS preference_supporting_content (
  preference_version TEXT NOT NULL REFERENCES preference_version(preference_version),
  content_id TEXT NOT NULL REFERENCES content(content_id),
  PRIMARY KEY(preference_version, content_id)
);
CREATE TRIGGER IF NOT EXISTS preference_supporting_content_guard BEFORE INSERT ON preference_supporting_content
WHEN NOT EXISTS (SELECT 1 FROM preference_version p, json_each(p.supporting_content_ids_json) j
  WHERE p.preference_version=NEW.preference_version AND j.value=NEW.content_id)
BEGIN SELECT RAISE(ABORT, 'supporting content must be declared by its preference version'); END;
CREATE TRIGGER IF NOT EXISTS preference_supporting_content_immutable_update BEFORE UPDATE ON preference_supporting_content
BEGIN SELECT RAISE(ABORT, 'preference supporting content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS preference_supporting_content_immutable_delete BEFORE DELETE ON preference_supporting_content
BEGIN SELECT RAISE(ABORT, 'preference supporting content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS preference_version_materialize_support AFTER INSERT ON preference_version
BEGIN
  INSERT INTO preference_supporting_content(preference_version,content_id)
  SELECT NEW.preference_version, j.value FROM json_each(NEW.supporting_content_ids_json) j WHERE j.type='text';
END;

CREATE TABLE IF NOT EXISTS strategy_version (
  strategy_version TEXT PRIMARY KEY,
  parent_version TEXT REFERENCES strategy_version(strategy_version),
  rule_diff_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  preference_version TEXT REFERENCES preference_version(preference_version),
  state TEXT NOT NULL DEFAULT 'unconfigured' CHECK (state IN ('unconfigured','active')),
  effective_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS baseline_version (
  baseline_version TEXT PRIMARY KEY,
  material_version_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(material_version_ids_json) AND json_type(material_version_ids_json)='array'),
  coverage_description TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS baseline_material_ids_guard BEFORE INSERT ON baseline_version
WHEN EXISTS (SELECT 1 FROM json_each(NEW.material_version_ids_json) WHERE type<>'text' OR length(value)=0)
BEGIN SELECT RAISE(ABORT, 'baseline material ids must be non-empty text'); END;
CREATE TABLE IF NOT EXISTS baseline_material (
  baseline_version TEXT NOT NULL REFERENCES baseline_version(baseline_version),
  material_version_id TEXT NOT NULL REFERENCES material_version(material_version_id),
  PRIMARY KEY(baseline_version, material_version_id)
);
CREATE TRIGGER IF NOT EXISTS baseline_material_guard BEFORE INSERT ON baseline_material
WHEN NOT EXISTS (SELECT 1 FROM baseline_version b, json_each(b.material_version_ids_json) j
  WHERE b.baseline_version=NEW.baseline_version AND j.value=NEW.material_version_id)
BEGIN SELECT RAISE(ABORT, 'baseline material must be declared by its baseline version'); END;
CREATE TRIGGER IF NOT EXISTS baseline_material_immutable_update BEFORE UPDATE ON baseline_material
BEGIN SELECT RAISE(ABORT, 'baseline materials are immutable'); END;
CREATE TRIGGER IF NOT EXISTS baseline_material_immutable_delete BEFORE DELETE ON baseline_material
BEGIN SELECT RAISE(ABORT, 'baseline materials are immutable'); END;
CREATE TRIGGER IF NOT EXISTS baseline_version_materialize_members AFTER INSERT ON baseline_version
BEGIN
  INSERT INTO baseline_material(baseline_version,material_version_id)
  SELECT NEW.baseline_version, j.value FROM json_each(NEW.material_version_ids_json) j WHERE j.type='text';
END;

CREATE TABLE IF NOT EXISTS batch (
  delivery_batch_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  command_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('daily_follow','additional_follow','explore','trial','manual_follow')),
  business_day TEXT NOT NULL,
  target INTEGER NOT NULL CHECK (target >= 0),
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','partial','blocked','stopped','closed_day')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  stop_requested INTEGER NOT NULL DEFAULT 0 CHECK (stop_requested IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(owner, command_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS batch_daily_owner_day_uq ON batch(owner, kind, business_day) WHERE kind='daily_follow';
CREATE UNIQUE INDEX IF NOT EXISTS batch_command_uq ON batch(owner, command_id) WHERE command_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS candidate (
  candidate_id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL REFERENCES content(content_id),
  discovery_batch_id TEXT NOT NULL REFERENCES batch(delivery_batch_id),
  source TEXT NOT NULL CHECK (source='homefeed'),
  discovered_at TEXT NOT NULL,
  source_evidence_ref TEXT NOT NULL,
  cursor_ref TEXT,
  eligibility_state TEXT NOT NULL CHECK (eligibility_state IN ('eligible','reject','hold','unknown')),
  UNIQUE(discovery_batch_id, content_id)
);
CREATE TRIGGER IF NOT EXISTS candidate_identity_immutable BEFORE UPDATE ON candidate
WHEN NEW.candidate_id IS NOT OLD.candidate_id OR NEW.content_id IS NOT OLD.content_id OR
  NEW.discovery_batch_id IS NOT OLD.discovery_batch_id OR NEW.source IS NOT OLD.source OR
  NEW.discovered_at IS NOT OLD.discovered_at OR NEW.source_evidence_ref IS NOT OLD.source_evidence_ref OR
  NEW.cursor_ref IS NOT OLD.cursor_ref
BEGIN SELECT RAISE(ABORT, 'candidate identity and source evidence are immutable'); END;

CREATE TABLE IF NOT EXISTS decision (
  decision_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidate(candidate_id),
  analysis_id TEXT NOT NULL REFERENCES analysis(analysis_id),
  baseline_version TEXT NOT NULL REFERENCES baseline_version(baseline_version),
  preference_version TEXT NOT NULL REFERENCES preference_version(preference_version),
  strategy_version TEXT NOT NULL REFERENCES strategy_version(strategy_version),
  category TEXT NOT NULL CHECK (category IN ('follow','explore')),
  relevance TEXT NOT NULL,
  gain_state TEXT NOT NULL CHECK (gain_state IN ('gain','no_gain','undecidable')),
  gain_evidence_json TEXT NOT NULL DEFAULT '[]',
  comparison_refs_json TEXT NOT NULL DEFAULT '[]',
  result TEXT NOT NULL CHECK (result IN ('eligible','reject','hold')),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS decision_binding_guard_insert BEFORE INSERT ON decision
WHEN NOT EXISTS (
  SELECT 1 FROM candidate c
  JOIN analysis a ON a.analysis_id=NEW.analysis_id
  JOIN material_version m ON m.material_version_id=a.material_version_id
  WHERE c.candidate_id=NEW.candidate_id AND c.content_id=m.content_id
)
BEGIN SELECT RAISE(ABORT, 'decision candidate and analysis must reference the same content'); END;
CREATE TRIGGER IF NOT EXISTS decision_binding_guard_update BEFORE UPDATE ON decision
WHEN NOT EXISTS (
  SELECT 1 FROM candidate c
  JOIN analysis a ON a.analysis_id=NEW.analysis_id
  JOIN material_version m ON m.material_version_id=a.material_version_id
  WHERE c.candidate_id=NEW.candidate_id AND c.content_id=m.content_id
)
BEGIN SELECT RAISE(ABORT, 'decision candidate and analysis must reference the same content'); END;

CREATE TABLE IF NOT EXISTS recommendation (
  recommendation_id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL REFERENCES content(content_id),
  delivery_batch_id TEXT NOT NULL REFERENCES batch(delivery_batch_id),
  decision_id TEXT NOT NULL REFERENCES decision(decision_id),
  category TEXT NOT NULL CHECK (category IN ('follow','explore')),
  actual_preference_version TEXT NOT NULL REFERENCES preference_version(preference_version),
  actual_strategy_version TEXT NOT NULL REFERENCES strategy_version(strategy_version),
  state TEXT NOT NULL CHECK (state IN ('pending','intent','succeeded','failed','unknown','cancelled_before_dispatch')),
  first_success_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(delivery_batch_id, content_id)
);
CREATE TRIGGER IF NOT EXISTS recommendation_binding_guard_insert BEFORE INSERT ON recommendation
WHEN NOT EXISTS (
  SELECT 1 FROM decision d
  JOIN candidate c ON c.candidate_id=d.candidate_id
  JOIN analysis a ON a.analysis_id=d.analysis_id
  JOIN material_version m ON m.material_version_id=a.material_version_id
  WHERE d.decision_id=NEW.decision_id AND c.content_id=NEW.content_id AND m.content_id=NEW.content_id
    AND d.category=NEW.category AND d.preference_version=NEW.actual_preference_version
    AND d.strategy_version=NEW.actual_strategy_version
)
BEGIN SELECT RAISE(ABORT, 'recommendation must match its decision content and versions'); END;
CREATE TRIGGER IF NOT EXISTS recommendation_binding_guard_update BEFORE UPDATE ON recommendation
WHEN NOT EXISTS (
  SELECT 1 FROM decision d
  JOIN candidate c ON c.candidate_id=d.candidate_id
  JOIN analysis a ON a.analysis_id=d.analysis_id
  JOIN material_version m ON m.material_version_id=a.material_version_id
  WHERE d.decision_id=NEW.decision_id AND c.content_id=NEW.content_id AND m.content_id=NEW.content_id
    AND d.category=NEW.category AND d.preference_version=NEW.actual_preference_version
    AND d.strategy_version=NEW.actual_strategy_version
)
BEGIN SELECT RAISE(ABORT, 'recommendation must match its decision content and versions'); END;
CREATE TRIGGER IF NOT EXISTS recommendation_identity_immutable BEFORE UPDATE ON recommendation
WHEN NEW.recommendation_id IS NOT OLD.recommendation_id OR NEW.content_id IS NOT OLD.content_id OR
  NEW.delivery_batch_id IS NOT OLD.delivery_batch_id OR NEW.decision_id IS NOT OLD.decision_id OR
  NEW.category IS NOT OLD.category OR NEW.actual_preference_version IS NOT OLD.actual_preference_version OR
  NEW.actual_strategy_version IS NOT OLD.actual_strategy_version OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'recommendation identity and attribution are immutable'); END;

CREATE TABLE IF NOT EXISTS delivered_content (
  owner TEXT NOT NULL,
  platform TEXT NOT NULL,
  source_content_id TEXT NOT NULL,
  recommendation_id TEXT NOT NULL REFERENCES recommendation(recommendation_id),
  first_success_at TEXT NOT NULL,
  PRIMARY KEY(owner, platform, source_content_id)
);
CREATE TRIGGER IF NOT EXISTS delivered_content_binding_guard BEFORE INSERT ON delivered_content
WHEN NOT EXISTS (
  SELECT 1 FROM recommendation r
  JOIN batch b ON b.delivery_batch_id=r.delivery_batch_id
  JOIN content c ON c.content_id=r.content_id
  WHERE r.recommendation_id=NEW.recommendation_id AND b.owner=NEW.owner
    AND c.platform=NEW.platform AND c.source_content_id=NEW.source_content_id
)
BEGIN SELECT RAISE(ABORT, 'delivered content must match recommendation owner and content'); END;
CREATE TRIGGER IF NOT EXISTS delivered_content_immutable_update BEFORE UPDATE ON delivered_content
BEGIN SELECT RAISE(ABORT, 'delivered content index is immutable'); END;
CREATE TRIGGER IF NOT EXISTS delivered_content_immutable_delete BEFORE DELETE ON delivered_content
BEGIN SELECT RAISE(ABORT, 'delivered content index is immutable'); END;

CREATE TABLE IF NOT EXISTS delivery_attempt (
  delivery_attempt_id TEXT PRIMARY KEY,
  recommendation_id TEXT NOT NULL REFERENCES recommendation(recommendation_id),
  target_ref TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  intent_at TEXT NOT NULL,
  dispatched_at TEXT,
  returned_at TEXT,
  message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','intent','succeeded','failed','unknown','cancelled_before_dispatch')),
  query_evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  verification_evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS delivery_attempt_history (
  history_id INTEGER PRIMARY KEY,
  delivery_attempt_id TEXT NOT NULL REFERENCES delivery_attempt(delivery_attempt_id),
  old_status TEXT,
  new_status TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  changed_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS delivery_attempt_unknown_success_guard
BEFORE UPDATE OF status ON delivery_attempt
WHEN NEW.status='succeeded' AND (NEW.message_id IS NULL OR length(trim(NEW.message_id))=0 OR
  json_valid(NEW.verification_evidence_refs_json)=0 OR json_type(NEW.verification_evidence_refs_json)<>'array' OR
  json_array_length(NEW.verification_evidence_refs_json)=0 OR NOT EXISTS
  (SELECT 1 FROM json_each(NEW.verification_evidence_refs_json) WHERE type='text' AND length(trim(value))>0))
BEGIN SELECT RAISE(ABORT, 'unknown delivery requires verification evidence'); END;
CREATE TRIGGER IF NOT EXISTS delivery_attempt_unknown_intent_guard
BEFORE INSERT ON delivery_attempt
WHEN NEW.status='intent' AND EXISTS (
  SELECT 1 FROM delivery_attempt prior
  JOIN recommendation pr ON pr.recommendation_id=prior.recommendation_id
  JOIN batch pb ON pb.delivery_batch_id=pr.delivery_batch_id
  JOIN recommendation nr ON nr.recommendation_id=NEW.recommendation_id
  JOIN batch nb ON nb.delivery_batch_id=nr.delivery_batch_id
  JOIN content pc ON pc.content_id=pr.content_id
  JOIN content nc ON nc.content_id=nr.content_id
  WHERE prior.status='unknown' AND pb.owner=nb.owner
    AND pc.platform=nc.platform AND pc.source_content_id=nc.source_content_id
)
BEGIN SELECT RAISE(ABORT, 'unknown delivery must be verified before a new intent'); END;
CREATE TRIGGER IF NOT EXISTS delivery_attempt_unknown_update_guard
BEFORE UPDATE OF status ON delivery_attempt
WHEN NEW.status='intent' AND (
  OLD.status='unknown' OR EXISTS (
    SELECT 1 FROM delivery_attempt prior
    JOIN recommendation pr ON pr.recommendation_id=prior.recommendation_id
    JOIN batch pb ON pb.delivery_batch_id=pr.delivery_batch_id
    JOIN recommendation nr ON nr.recommendation_id=NEW.recommendation_id
    JOIN batch nb ON nb.delivery_batch_id=nr.delivery_batch_id
    JOIN content pc ON pc.content_id=pr.content_id
    JOIN content nc ON nc.content_id=nr.content_id
    WHERE prior.delivery_attempt_id<>OLD.delivery_attempt_id AND prior.status='unknown'
      AND pb.owner=nb.owner AND pc.platform=nc.platform AND pc.source_content_id=nc.source_content_id
  )
)
BEGIN SELECT RAISE(ABORT, 'unknown delivery must be verified before a new intent'); END;
CREATE TRIGGER IF NOT EXISTS delivery_attempt_identity_immutable BEFORE UPDATE ON delivery_attempt
WHEN NEW.delivery_attempt_id IS NOT OLD.delivery_attempt_id OR NEW.recommendation_id IS NOT OLD.recommendation_id OR
  NEW.target_ref IS NOT OLD.target_ref OR NEW.payload_hash IS NOT OLD.payload_hash OR
  NEW.intent_at IS NOT OLD.intent_at OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'delivery attempt identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS delivery_attempt_insert_success_guard
BEFORE INSERT ON delivery_attempt
WHEN NEW.status='succeeded' AND (NEW.message_id IS NULL OR length(trim(NEW.message_id))=0 OR
  json_valid(NEW.verification_evidence_refs_json)=0 OR json_type(NEW.verification_evidence_refs_json)<>'array' OR
  json_array_length(NEW.verification_evidence_refs_json)=0 OR NOT EXISTS
  (SELECT 1 FROM json_each(NEW.verification_evidence_refs_json) WHERE type='text' AND length(trim(value))>0))
BEGIN SELECT RAISE(ABORT, 'successful delivery requires message and verification evidence'); END;
CREATE TRIGGER IF NOT EXISTS delivery_attempt_history_insert
AFTER INSERT ON delivery_attempt
BEGIN
  INSERT INTO delivery_attempt_history(delivery_attempt_id, old_status, new_status, evidence_refs_json, changed_at)
  VALUES(NEW.delivery_attempt_id, NULL, NEW.status, NEW.verification_evidence_refs_json, NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS delivery_attempt_history_update
AFTER UPDATE OF status ON delivery_attempt
WHEN OLD.status <> NEW.status
BEGIN
  INSERT INTO delivery_attempt_history(delivery_attempt_id, old_status, new_status, evidence_refs_json, changed_at)
  VALUES(NEW.delivery_attempt_id, OLD.status, NEW.status, NEW.verification_evidence_refs_json, NEW.updated_at);
END;

CREATE TABLE IF NOT EXISTS feedback_event (
  app_ref TEXT NOT NULL,
  chat_ref TEXT NOT NULL,
  event_id TEXT NOT NULL,
  recommendation_id TEXT REFERENCES recommendation(recommendation_id),
  content_id TEXT REFERENCES content(content_id),
  value TEXT CHECK (value IN ('like','dislike','seen')),
  received_at TEXT NOT NULL,
  saved_at TEXT,
  revision INTEGER,
  correction_of_event_id TEXT,
  parse_state TEXT NOT NULL CHECK (parse_state IN ('parsed','ambiguous','unmatched','invalid')),
  association_state TEXT NOT NULL CHECK (association_state IN ('matched','ambiguous','unmatched')),
  PRIMARY KEY(app_ref, chat_ref, event_id),
  UNIQUE(app_ref, chat_ref, event_id, recommendation_id, content_id)
);
CREATE TRIGGER IF NOT EXISTS feedback_event_binding_guard_insert BEFORE INSERT ON feedback_event
WHEN NEW.recommendation_id IS NOT NULL AND NEW.content_id IS NOT NULL AND
  NOT EXISTS(SELECT 1 FROM recommendation WHERE recommendation_id=NEW.recommendation_id AND content_id=NEW.content_id)
BEGIN SELECT RAISE(ABORT, 'feedback event recommendation and content mismatch'); END;
CREATE TRIGGER IF NOT EXISTS feedback_event_binding_guard_update BEFORE UPDATE ON feedback_event
WHEN NEW.recommendation_id IS NOT OLD.recommendation_id OR NEW.content_id IS NOT OLD.content_id OR
  NEW.app_ref IS NOT OLD.app_ref OR NEW.chat_ref IS NOT OLD.chat_ref OR NEW.event_id IS NOT OLD.event_id
BEGIN SELECT RAISE(ABORT, 'feedback event identity and attribution are immutable'); END;
CREATE TRIGGER IF NOT EXISTS feedback_event_saved_immutable_update BEFORE UPDATE ON feedback_event
WHEN OLD.saved_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'saved feedback events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS feedback_event_saved_immutable_delete BEFORE DELETE ON feedback_event
WHEN OLD.saved_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'saved feedback events are immutable'); END;

CREATE TABLE IF NOT EXISTS feedback_current (
  owner TEXT NOT NULL,
  app_ref TEXT NOT NULL,
  chat_ref TEXT NOT NULL,
  platform TEXT NOT NULL,
  source_content_id TEXT NOT NULL,
  content_id TEXT NOT NULL REFERENCES content(content_id),
  recommendation_id TEXT NOT NULL REFERENCES recommendation(recommendation_id),
  value TEXT NOT NULL CHECK (value IN ('like','dislike','seen')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  event_id TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY(owner, platform, source_content_id),
  UNIQUE(recommendation_id),
  UNIQUE(owner, platform, source_content_id, revision),
  FOREIGN KEY(app_ref, chat_ref, event_id, recommendation_id, content_id)
    REFERENCES feedback_event(app_ref, chat_ref, event_id, recommendation_id, content_id)
);
CREATE TRIGGER IF NOT EXISTS feedback_current_binding_guard BEFORE INSERT ON feedback_current
WHEN NOT EXISTS (
  SELECT 1 FROM recommendation r
  JOIN batch b ON b.delivery_batch_id=r.delivery_batch_id
  JOIN content c ON c.content_id=r.content_id
  JOIN feedback_event e ON e.app_ref=NEW.app_ref AND e.chat_ref=NEW.chat_ref AND e.event_id=NEW.event_id
  WHERE r.recommendation_id=NEW.recommendation_id AND r.content_id=NEW.content_id
    AND b.owner=NEW.owner AND c.platform=NEW.platform AND c.source_content_id=NEW.source_content_id
    AND e.recommendation_id=NEW.recommendation_id AND e.content_id=NEW.content_id
)
BEGIN SELECT RAISE(ABORT, 'feedback current must match event, recommendation, owner and content'); END;
CREATE TRIGGER IF NOT EXISTS feedback_current_identity_immutable BEFORE UPDATE ON feedback_current
WHEN NEW.owner IS NOT OLD.owner OR NEW.app_ref IS NOT OLD.app_ref OR NEW.chat_ref IS NOT OLD.chat_ref OR
  NEW.platform IS NOT OLD.platform OR NEW.source_content_id IS NOT OLD.source_content_id OR
  NEW.content_id IS NOT OLD.content_id OR NEW.recommendation_id IS NOT OLD.recommendation_id
BEGIN SELECT RAISE(ABORT, 'feedback attribution is immutable'); END;

CREATE TABLE IF NOT EXISTS feedback_history (
  feedback_history_id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  app_ref TEXT NOT NULL,
  chat_ref TEXT NOT NULL,
  platform TEXT NOT NULL,
  source_content_id TEXT NOT NULL,
  content_id TEXT NOT NULL REFERENCES content(content_id),
  recommendation_id TEXT NOT NULL REFERENCES recommendation(recommendation_id),
  value TEXT NOT NULL CHECK (value IN ('like','dislike','seen')),
  revision INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  correction_of_event_id TEXT,
  UNIQUE(owner, platform, source_content_id, revision),
  FOREIGN KEY(app_ref, chat_ref, event_id, recommendation_id, content_id)
    REFERENCES feedback_event(app_ref, chat_ref, event_id, recommendation_id, content_id)
);
CREATE TRIGGER IF NOT EXISTS feedback_current_revision_guard BEFORE UPDATE ON feedback_current
WHEN NEW.revision<>OLD.revision+1
BEGIN SELECT RAISE(ABORT, 'feedback current update requires revision CAS'); END;
CREATE TRIGGER IF NOT EXISTS feedback_current_history_insert AFTER INSERT ON feedback_current
BEGIN
  INSERT INTO feedback_history(owner,app_ref,chat_ref,platform,source_content_id,content_id,recommendation_id,value,revision,event_id,saved_at,correction_of_event_id)
  VALUES(NEW.owner,NEW.app_ref,NEW.chat_ref,NEW.platform,NEW.source_content_id,NEW.content_id,NEW.recommendation_id,NEW.value,NEW.revision,NEW.event_id,NEW.saved_at,
    (SELECT correction_of_event_id FROM feedback_event WHERE app_ref=NEW.app_ref AND chat_ref=NEW.chat_ref AND event_id=NEW.event_id));
END;
CREATE TRIGGER IF NOT EXISTS feedback_current_history_update AFTER UPDATE ON feedback_current
WHEN NEW.value<>OLD.value
BEGIN
  INSERT INTO feedback_history(owner,app_ref,chat_ref,platform,source_content_id,content_id,recommendation_id,value,revision,event_id,saved_at,correction_of_event_id)
  VALUES(NEW.owner,NEW.app_ref,NEW.chat_ref,NEW.platform,NEW.source_content_id,NEW.content_id,NEW.recommendation_id,NEW.value,NEW.revision,NEW.event_id,NEW.saved_at,
    (SELECT correction_of_event_id FROM feedback_event WHERE app_ref=NEW.app_ref AND chat_ref=NEW.chat_ref AND event_id=NEW.event_id));
END;

CREATE TABLE IF NOT EXISTS outbox (
  outbox_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('feedback_receipt','incident_alert')),
  object_ref TEXT NOT NULL,
  business_revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','intent','succeeded','failed','unknown','cancelled')),
  attempt_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  UNIQUE(kind, object_ref, business_revision)
);
CREATE TRIGGER IF NOT EXISTS outbox_identity_immutable BEFORE UPDATE ON outbox
WHEN NEW.outbox_id IS NOT OLD.outbox_id OR NEW.kind IS NOT OLD.kind OR NEW.object_ref IS NOT OLD.object_ref OR
  NEW.business_revision IS NOT OLD.business_revision OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'outbox identity is immutable'); END;

CREATE TABLE IF NOT EXISTS sample (
  sample_id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('follow','explore')),
  included_from TEXT,
  included_until TEXT,
  target_total INTEGER CHECK (target_total IS NULL OR target_total >= 0),
  cutoff_at TEXT,
  strategy_version TEXT REFERENCES strategy_version(strategy_version),
  event_revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sample_member (
  sample_id TEXT NOT NULL REFERENCES sample(sample_id),
  recommendation_id TEXT NOT NULL REFERENCES recommendation(recommendation_id),
  PRIMARY KEY(sample_id, recommendation_id)
);
CREATE TABLE IF NOT EXISTS report_revision (
  report_revision_id TEXT PRIMARY KEY,
  sample_id TEXT NOT NULL REFERENCES sample(sample_id),
  parent_report_revision_id TEXT REFERENCES report_revision(report_revision_id),
  event_revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS incident (
  incident_id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  report_revision_id TEXT REFERENCES report_revision(report_revision_id),
  baseline_version TEXT REFERENCES baseline_version(baseline_version),
  adjustment_index INTEGER CHECK (adjustment_index IS NULL OR adjustment_index IN (1,2)),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_slot (
  slot_key TEXT PRIMARY KEY CHECK (slot_key='main'),
  owner TEXT,
  run_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  batch_id TEXT REFERENCES batch(delivery_batch_id),
  state TEXT NOT NULL CHECK (state IN ('idle','running','stopping','stopped','recovery_required')),
  stop_requested INTEGER NOT NULL DEFAULT 0 CHECK (stop_requested IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO execution_slot(slot_key, state, updated_at) VALUES('main','idle','1970-01-01T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS checkpoint (
  checkpoint_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  run_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  delivery_batch_id TEXT REFERENCES batch(delivery_batch_id),
  stage TEXT NOT NULL,
  pending_ids_json TEXT NOT NULL DEFAULT '[]',
  succeeded_refs_json TEXT NOT NULL DEFAULT '[]',
  failed_refs_json TEXT NOT NULL DEFAULT '[]',
  unknown_refs_json TEXT NOT NULL DEFAULT '[]',
  input_hash TEXT,
  output_hash TEXT,
  stop_requested INTEGER NOT NULL DEFAULT 0 CHECK (stop_requested IN (0,1)),
  committed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entity_state_history (
  history_id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  old_state TEXT NOT NULL,
  new_state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  changed_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS batch_cas_guard BEFORE UPDATE OF status ON batch
WHEN NEW.status<>OLD.status AND NEW.revision<>OLD.revision+1
BEGIN SELECT RAISE(ABORT, 'batch state change requires revision CAS'); END;
CREATE TRIGGER IF NOT EXISTS batch_identity_immutable BEFORE UPDATE ON batch
WHEN NEW.delivery_batch_id IS NOT OLD.delivery_batch_id OR NEW.owner IS NOT OLD.owner OR
  NEW.command_id IS NOT OLD.command_id OR NEW.kind IS NOT OLD.kind OR NEW.business_day IS NOT OLD.business_day OR
  NEW.target IS NOT OLD.target OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'batch identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS recommendation_cas_guard BEFORE UPDATE OF state ON recommendation
WHEN NEW.state<>OLD.state AND NEW.revision<>OLD.revision+1
BEGIN SELECT RAISE(ABORT, 'recommendation state change requires revision CAS'); END;
CREATE TRIGGER IF NOT EXISTS delivery_attempt_cas_guard BEFORE UPDATE OF status ON delivery_attempt
WHEN NEW.status<>OLD.status AND NEW.revision<>OLD.revision+1
BEGIN SELECT RAISE(ABORT, 'delivery attempt state change requires revision CAS'); END;
CREATE TRIGGER IF NOT EXISTS outbox_cas_guard BEFORE UPDATE OF state ON outbox
WHEN NEW.state<>OLD.state AND NEW.revision<>OLD.revision+1
BEGIN SELECT RAISE(ABORT, 'outbox state change requires revision CAS'); END;
CREATE TRIGGER IF NOT EXISTS slot_cas_guard BEFORE UPDATE OF owner,run_id,generation,state,stop_requested ON execution_slot
WHEN NEW.revision<>OLD.revision+1
BEGIN SELECT RAISE(ABORT, 'execution slot change requires revision CAS'); END;

CREATE TRIGGER IF NOT EXISTS batch_history AFTER UPDATE OF status ON batch
WHEN OLD.status<>NEW.status
BEGIN INSERT INTO entity_state_history(entity_type,entity_id,old_state,new_state,revision,changed_at)
  VALUES('batch',NEW.delivery_batch_id,OLD.status,NEW.status,NEW.revision,NEW.updated_at); END;
CREATE TRIGGER IF NOT EXISTS recommendation_history AFTER UPDATE OF state ON recommendation
WHEN OLD.state<>NEW.state
BEGIN INSERT INTO entity_state_history(entity_type,entity_id,old_state,new_state,revision,changed_at)
  VALUES('recommendation',NEW.recommendation_id,OLD.state,NEW.state,NEW.revision,NEW.updated_at); END;
CREATE TRIGGER IF NOT EXISTS attempt_history AFTER UPDATE OF status ON delivery_attempt
WHEN OLD.status<>NEW.status
BEGIN INSERT INTO entity_state_history(entity_type,entity_id,old_state,new_state,revision,evidence_refs_json,changed_at)
  VALUES('delivery_attempt',NEW.delivery_attempt_id,OLD.status,NEW.status,NEW.revision,NEW.verification_evidence_refs_json,NEW.updated_at); END;
CREATE TRIGGER IF NOT EXISTS outbox_history AFTER UPDATE OF state ON outbox
WHEN OLD.state<>NEW.state
BEGIN INSERT INTO entity_state_history(entity_type,entity_id,old_state,new_state,revision,changed_at)
  VALUES('outbox',NEW.outbox_id,OLD.state,NEW.state,NEW.revision,NEW.updated_at); END;
CREATE TRIGGER IF NOT EXISTS slot_history AFTER UPDATE OF owner,run_id,generation,state,stop_requested ON execution_slot
WHEN OLD.owner IS NOT NEW.owner OR OLD.run_id IS NOT NEW.run_id OR OLD.generation<>NEW.generation OR OLD.state<>NEW.state OR OLD.stop_requested<>NEW.stop_requested
BEGIN INSERT INTO entity_state_history(entity_type,entity_id,old_state,new_state,revision,changed_at)
  VALUES('execution_slot','main',OLD.state,NEW.state,NEW.revision,NEW.updated_at); END;
CREATE TRIGGER IF NOT EXISTS entity_state_history_immutable_update BEFORE UPDATE ON entity_state_history
BEGIN SELECT RAISE(ABORT, 'state history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS entity_state_history_immutable_delete BEFORE DELETE ON entity_state_history
BEGIN SELECT RAISE(ABORT, 'state history is immutable'); END;

CREATE TRIGGER IF NOT EXISTS material_version_immutable_update BEFORE UPDATE ON material_version
BEGIN SELECT RAISE(ABORT, 'material versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS material_version_immutable_delete BEFORE DELETE ON material_version
BEGIN SELECT RAISE(ABORT, 'material versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS analysis_immutable_update BEFORE UPDATE ON analysis
BEGIN SELECT RAISE(ABORT, 'analysis records are immutable'); END;
CREATE TRIGGER IF NOT EXISTS analysis_immutable_delete BEFORE DELETE ON analysis
BEGIN SELECT RAISE(ABORT, 'analysis records are immutable'); END;
CREATE TRIGGER IF NOT EXISTS preference_version_immutable_update BEFORE UPDATE ON preference_version
BEGIN SELECT RAISE(ABORT, 'preference versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS preference_version_immutable_delete BEFORE DELETE ON preference_version
BEGIN SELECT RAISE(ABORT, 'preference versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS strategy_version_immutable_update BEFORE UPDATE ON strategy_version
BEGIN SELECT RAISE(ABORT, 'strategy versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS strategy_version_immutable_delete BEFORE DELETE ON strategy_version
BEGIN SELECT RAISE(ABORT, 'strategy versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS baseline_version_immutable_update BEFORE UPDATE ON baseline_version
BEGIN SELECT RAISE(ABORT, 'baseline versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS baseline_version_immutable_delete BEFORE DELETE ON baseline_version
BEGIN SELECT RAISE(ABORT, 'baseline versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS decision_immutable_update BEFORE UPDATE ON decision
BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS decision_immutable_delete BEFORE DELETE ON decision
BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS report_revision_immutable_update BEFORE UPDATE ON report_revision
BEGIN SELECT RAISE(ABORT, 'report revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS report_revision_immutable_delete BEFORE DELETE ON report_revision
BEGIN SELECT RAISE(ABORT, 'report revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS feedback_history_immutable_update BEFORE UPDATE ON feedback_history
BEGIN SELECT RAISE(ABORT, 'feedback history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS feedback_history_immutable_delete BEFORE DELETE ON feedback_history
BEGIN SELECT RAISE(ABORT, 'feedback history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS attempt_history_immutable_update BEFORE UPDATE ON delivery_attempt_history
BEGIN SELECT RAISE(ABORT, 'delivery history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS attempt_history_immutable_delete BEFORE DELETE ON delivery_attempt_history
BEGIN SELECT RAISE(ABORT, 'delivery history is immutable'); END;
