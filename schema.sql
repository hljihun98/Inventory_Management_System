-- =====================================================================
-- LOT-IMS 데이터베이스 스키마 (PostgreSQL 14+)
-- 품목 / 로트 / 재고 / 위치 / 이력 / 사용자
-- 프로토타입(HTML 앱)의 데이터 구조와 1:1 대응되며,
-- 프로덕션 백엔드 구축 시 그대로 사용할 수 있습니다.
-- =====================================================================

-- 사용자 및 권한 -------------------------------------------------------
CREATE TABLE users (
    user_id       VARCHAR(30)  PRIMARY KEY,            -- 로그인 아이디
    name          VARCHAR(50)  NOT NULL,
    role          VARCHAR(10)  NOT NULL CHECK (role IN ('admin','worker')),
    password_hash TEXT         NOT NULL,               -- bcrypt/argon2 권장
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 품목 마스터 ----------------------------------------------------------
CREATE TABLE items (
    item_code       VARCHAR(12) PRIMARY KEY,           -- 예: BRKT01
    name            VARCHAR(100) NOT NULL,
    unit            VARCHAR(10)  NOT NULL DEFAULT 'EA',
    safety_stock    INTEGER      NOT NULL DEFAULT 0 CHECK (safety_stock >= 0),
    shelf_life_days INTEGER      NOT NULL DEFAULT 0 CHECK (shelf_life_days >= 0), -- 0 = 유통기한 없음
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 보관 위치 (창고/구역/랙) ---------------------------------------------
CREATE TABLE locations (
    location_code VARCHAR(20) PRIMARY KEY,             -- 예: A-01-03
    warehouse     VARCHAR(50) NOT NULL,
    zone          VARCHAR(50) NOT NULL,
    rack          VARCHAR(50) NOT NULL,
    memo          TEXT
);

-- 로트 (바코드 발행 단위) ----------------------------------------------
-- 로트번호 규칙: {item_code}-{YYYYMMDD}-{일련번호 3자리}
CREATE TABLE lots (
    lot_no        VARCHAR(30) PRIMARY KEY,
    item_code     VARCHAR(12) NOT NULL REFERENCES items(item_code),
    mfg_date      DATE        NOT NULL,
    expiry_date   DATE,                                -- mfg_date + shelf_life_days (트리거/앱에서 계산)
    created_by    VARCHAR(30) REFERENCES users(user_id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lots_item ON lots(item_code, mfg_date);  -- FIFO 조회용

-- 현재 재고 (로트 × 위치) ----------------------------------------------
CREATE TABLE inventory (
    lot_no        VARCHAR(30) NOT NULL REFERENCES lots(lot_no),
    location_code VARCHAR(20) REFERENCES locations(location_code),
    qty           INTEGER     NOT NULL DEFAULT 0 CHECK (qty >= 0),  -- 음수 재고 금지
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (lot_no)                               -- 로트당 단일 위치 모델
    -- 로트를 여러 위치에 분산 보관하려면 PRIMARY KEY (lot_no, location_code)로 변경
);

-- 입·출고 이력 (전수 기록, 수정/삭제 금지 append-only) --------------------
CREATE TABLE stock_transactions (
    tx_id         BIGSERIAL   PRIMARY KEY,
    tx_type       VARCHAR(10) NOT NULL CHECK (tx_type IN ('IN','OUT','MOVE','CREATE','ADJUST')),
    lot_no        VARCHAR(30) NOT NULL REFERENCES lots(lot_no),
    item_code     VARCHAR(12) NOT NULL REFERENCES items(item_code),
    qty           INTEGER     NOT NULL DEFAULT 0,
    qty_before    INTEGER,
    qty_after     INTEGER,
    location_code VARCHAR(20),
    reason        TEXT,
    user_id       VARCHAR(30) NOT NULL REFERENCES users(user_id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tx_lot  ON stock_transactions(lot_no, created_at);
CREATE INDEX idx_tx_time ON stock_transactions(created_at DESC);

-- 편의 뷰: 품목별 현재고 + 안전재고 상태 -----------------------------------
CREATE VIEW v_item_stock AS
SELECT i.item_code, i.name, i.unit, i.safety_stock,
       COALESCE(SUM(inv.qty),0) AS total_qty,
       COALESCE(SUM(inv.qty),0) < i.safety_stock AS below_safety
FROM items i
LEFT JOIN lots l   ON l.item_code = i.item_code
LEFT JOIN inventory inv ON inv.lot_no = l.lot_no
GROUP BY i.item_code;

-- 편의 뷰: FIFO 출고 우선순위 --------------------------------------------
CREATE VIEW v_fifo AS
SELECT l.item_code, l.lot_no, l.mfg_date, l.expiry_date, inv.qty, inv.location_code,
       ROW_NUMBER() OVER (PARTITION BY l.item_code ORDER BY l.mfg_date, l.lot_no) AS fifo_rank
FROM lots l JOIN inventory inv ON inv.lot_no = l.lot_no
WHERE inv.qty > 0;

-- 동시성 처리 예시: 출고는 반드시 행 잠금 후 검증-차감을 한 트랜잭션으로
--   BEGIN;
--     SELECT qty FROM inventory WHERE lot_no = $1 FOR UPDATE;
--     -- qty >= 출고수량 검증 후
--     UPDATE inventory SET qty = qty - $2, updated_at = now() WHERE lot_no = $1;
--     INSERT INTO stock_transactions (tx_type, lot_no, item_code, qty, qty_before, qty_after, user_id, reason)
--     VALUES ('OUT', $1, $3, $2, $4, $5, $6, $7);
--   COMMIT;
