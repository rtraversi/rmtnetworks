-- New Deed demo: seed table for the 5 fake "new deed" entries.
-- Run once in the Supabase SQL editor.
--
-- Production note: when the attorney goes live, this table is replaced by
-- a call to her secure vault. Swap /lib/deed-source.js from `supabase` to
-- `vault` and point the env var VAULT_API_URL at her source.

create extension if not exists "pgcrypto";

create table if not exists demo_new_deeds (
  id                    uuid primary key default gen_random_uuid(),
  -- label shown in the dropdown
  label                 text not null,
  -- party info
  grantor_name          text not null,
  grantor_address       text not null,
  grantee_name          text not null,
  grantee_address       text not null,
  -- transaction
  consideration_amount  numeric(14,2) not null default 0,
  consideration_words   text,                -- e.g. "Ten Dollars ($10.00) and other good and valuable consideration"
  conveyance_date       date not null default current_date,
  deed_type             text not null default 'Bargain and Sale Deed With Covenants'
                          check (deed_type in (
                            'Bargain and Sale Deed With Covenants',
                            'Bargain and Sale Deed Without Covenants',
                            'Quitclaim Deed',
                            'Warranty Deed',
                            'Executor''s Deed'
                          )),
  -- property
  property_address      text not null,
  property_city         text not null,
  property_state        text not null default 'New York',
  property_county       text not null default 'Westchester',
  tax_section           text,
  tax_block             text,
  tax_lot               text,
  legal_description     text not null,
  -- meta
  notes                 text,
  created_at            timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Seed data: 5 fictional "new deed" scenarios for the demo dropdown.
-- All names, addresses, and amounts are fabricated. Address formats mirror
-- real Scarsdale/Westchester conventions for realism.
-- ---------------------------------------------------------------------------

insert into demo_new_deeds
  (label, grantor_name, grantor_address, grantee_name, grantee_address,
   consideration_amount, consideration_words, conveyance_date, deed_type,
   property_address, property_city, tax_section, tax_block, tax_lot,
   legal_description, notes)
values
  -- 1. Standard sale to a married couple
  ('1. Sale to married couple — $1.45M',
   'Margaret E. Whitfield',
   '12 Heathcote Road, Scarsdale, NY 10583',
   'David A. Patel and Anjali R. Patel, as tenants by the entirety',
   '847 Riverside Drive, Apt 14C, New York, NY 10025',
   1450000.00,
   'One Million Four Hundred Fifty Thousand and 00/100 Dollars ($1,450,000.00)',
   '2026-06-15',
   'Bargain and Sale Deed With Covenants',
   '12 Heathcote Road',
   'Scarsdale',
   '167.16', '2', '14',
   'ALL that certain plot, piece or parcel of land, with the buildings and improvements thereon erected, situate, lying and being in the Village of Scarsdale, Town of Scarsdale, County of Westchester, State of New York, known and designated as Lot No. 14 in Block 2 on a certain map entitled "Heathcote Park Section Three" filed in the Westchester County Clerk''s Office on June 8, 1928 as Map No. 3461.',
   'Standard arm''s-length residential sale.'),

  -- 2. Transfer to a revocable living trust
  ('2. Transfer to revocable trust — nominal',
   'Margaret E. Whitfield',
   '12 Heathcote Road, Scarsdale, NY 10583',
   'Margaret E. Whitfield, as Trustee of the Margaret E. Whitfield Revocable Trust dated March 4, 2024',
   '12 Heathcote Road, Scarsdale, NY 10583',
   10.00,
   'Ten Dollars ($10.00) and other good and valuable consideration',
   '2026-06-15',
   'Quitclaim Deed',
   '12 Heathcote Road',
   'Scarsdale',
   '167.16', '2', '14',
   'ALL that certain plot, piece or parcel of land, with the buildings and improvements thereon erected, situate, lying and being in the Village of Scarsdale, Town of Scarsdale, County of Westchester, State of New York, known and designated as Lot No. 14 in Block 2 on a certain map entitled "Heathcote Park Section Three" filed in the Westchester County Clerk''s Office on June 8, 1928 as Map No. 3461.',
   'Estate-planning transfer into client''s own revocable trust. Tax-neutral.'),

  -- 3. Gift to adult children (joint with right of survivorship)
  ('3. Gift to adult children — JTWROS',
   'Margaret E. Whitfield',
   '12 Heathcote Road, Scarsdale, NY 10583',
   'Caroline E. Whitfield and Thomas R. Whitfield, as joint tenants with right of survivorship',
   '12 Heathcote Road, Scarsdale, NY 10583',
   1.00,
   'One Dollar ($1.00), love and affection, and other good and valuable consideration',
   '2026-06-15',
   'Bargain and Sale Deed Without Covenants',
   '12 Heathcote Road',
   'Scarsdale',
   '167.16', '2', '14',
   'ALL that certain plot, piece or parcel of land, with the buildings and improvements thereon erected, situate, lying and being in the Village of Scarsdale, Town of Scarsdale, County of Westchester, State of New York, known and designated as Lot No. 14 in Block 2 on a certain map entitled "Heathcote Park Section Three" filed in the Westchester County Clerk''s Office on June 8, 1928 as Map No. 3461.',
   'Inter-vivos gift. Verify gift-tax reporting (Form 709).'),

  -- 4. Quitclaim to surviving spouse after death
  ('4. Quitclaim to surviving spouse',
   'Estate of Robert J. Whitfield, by Margaret E. Whitfield, Executrix',
   '12 Heathcote Road, Scarsdale, NY 10583',
   'Margaret E. Whitfield, individually',
   '12 Heathcote Road, Scarsdale, NY 10583',
   0.00,
   'No consideration — distribution under Last Will and Testament',
   '2026-06-15',
   'Executor''s Deed',
   '12 Heathcote Road',
   'Scarsdale',
   '167.16', '2', '14',
   'ALL that certain plot, piece or parcel of land, with the buildings and improvements thereon erected, situate, lying and being in the Village of Scarsdale, Town of Scarsdale, County of Westchester, State of New York, known and designated as Lot No. 14 in Block 2 on a certain map entitled "Heathcote Park Section Three" filed in the Westchester County Clerk''s Office on June 8, 1928 as Map No. 3461.',
   'Distribution of decedent''s share to surviving spouse under will dated Aug 12, 2019. Westchester Surrogate''s Court File No. 2026-0451.'),

  -- 5. Sale to LLC (investment purchase)
  ('5. Sale to LLC — $1.62M investment',
   'Margaret E. Whitfield',
   '12 Heathcote Road, Scarsdale, NY 10583',
   'Heathcote Holdings LLC, a New York limited liability company',
   '388 Mamaroneck Avenue, Suite 410, White Plains, NY 10605',
   1620000.00,
   'One Million Six Hundred Twenty Thousand and 00/100 Dollars ($1,620,000.00)',
   '2026-06-15',
   'Warranty Deed',
   '12 Heathcote Road',
   'Scarsdale',
   '167.16', '2', '14',
   'ALL that certain plot, piece or parcel of land, with the buildings and improvements thereon erected, situate, lying and being in the Village of Scarsdale, Town of Scarsdale, County of Westchester, State of New York, known and designated as Lot No. 14 in Block 2 on a certain map entitled "Heathcote Park Section Three" filed in the Westchester County Clerk''s Office on June 8, 1928 as Map No. 3461.',
   'Sale to investment LLC. Confirm transfer-tax (TP-584) calculation.');

create index if not exists idx_demo_new_deeds_label on demo_new_deeds(label);
