Every table is aggregated from the parcel exports; nothing parcel-level is published except the map tiles. Keys: `u` is the township id (0 to 4133; 4134 is UNASSIGNED, parcels with no township), `s` the export index, `i` or `interval` the interval index (interval i runs from export i to export i+1), `county_n` the county code (in the holdings, cama and dormant tables 0 is the statewide row). A value of -1 means unknown. Counts with the prefix `n_` are parcels; `ac_` and `acres` are acres. The township stock tables are delta-coded on disk; read_series undoes that, so never read them any other way. Column families decode with the code lists above: `n_sz0..7`/`ac_sz0..7` by size, `n_loc0..4`/`ac_loc0..4` by locality, `n_ten0..2`/`ac_ten0..2` by tenure, `n_dev0..4`/`ac_dev0..4` by dev_stage, `n_oc0..8` by owner_class, `n_st0..11` by owner_origin, `n_cd0..7` by condition, `n_yb0..8` by year_built.

## Stock by export (read_series; township tables keyed `u`,`s`; county_stock keyed `county_n`,`s`)

### twp_core
One row per township and export. `parcels`, `acres`; `quarters` = distinct quarter-sections holding a parcel; `n_condo` = condominium units; `n_named_subdiv` = parcels carrying a subdivision or certificate-of-survey name; `coverage_ok` = 1 when the township's record is complete and comparable in that export (the coverage gate; 0 means masked, not zero).

### twp_dev
Development ladder: `n_dev0..4` parcels and `ac_dev0..4` acres by dev_stage (0 platted only, 1 addressed not built, 2 built, 3 unknown, 4 common area, which is off the ladder). The addressed-but-unbuilt share is n_dev1 over n_dev0+n_dev1+n_dev2 (derived measure addressed_unbuilt_share, floor 25 parcels).

### twp_tenure
`n_ten0..2`, `ac_ten0..2` by tenure (public domain, tribal trust, private); `n_on_public_land` = parcels inside the public-lands layer.

### twp_locality
Owner distance from the land, from the mailing address: `n_loc0..4`, `ac_loc0..4` by locality (local, same_county, in_state, out_of_state, unknown). The local tier is not comparable across 2009; the three-tier collapse (in county = 0+1, elsewhere in Montana = 2, out of state or unknown = 3+4) is.

### twp_size
Parcel-size classes: `n_sz0..7`, `ac_sz0..7` by size (0 unknown, then <1, 1-5, 5-20, 20-40, 40-160, 160-640, >640 acres).

### twp_class
Owner legal form: `n_oc0..8` by owner_class (federal, state, local_government, tribal, institution, private_entity, trust_estate, individual, indeterminate), inferred from names, 98% accurate on a calibration set.

### twp_owner_origin
Owner mailing state in twelve buckets: `n_st0..11` by owner_origin (MT, CA, WA, TX, CO, FL, AZ, ID, UT, WY, other_us, unknown).

### twp_ag
Agricultural use: `n_ag` parcels with any agricultural-use acreage, `ag_acres` (clamped to the parcel's own area), `n_ag_business` parcels with an agricultural business, `ag_available` = 1 when the export's agricultural block is populated (0 in 2009-07-05: unknown, not zero).

### twp_improve
The ladder's inputs: `n_improved` parcels with an assessed building value, `n_unimproved`, `n_improve_unknown` (the dead 2009-07-05 block), `n_with_addr` any situs address, `n_with_house_number` a house number (the stable middle rung).

### county_stock
One row per county and export with every family above in one table: `parcels`, `acres`, `quarters`, `n_condo`, `n_named_subdiv`, `n_improved`, `n_unimproved`, `n_improve_unknown`, `n_on_public_land`, `n_ag`, `ag_acres`, `ag_available`, `n_ag_business`, `n_with_addr`, `n_with_house_number`, `n_sz0..7`, `ac_sz0..7`, `n_st0..11`, `n_loc0..4`, `ac_loc0..4`, `n_oc0..8`, `n_ten0..2`, `ac_ten0..2`, `n_dev0..4`, `ac_dev0..4`, `coverage_ok`; plus `n_entity` parcels owned by an entity rather than a person, `n_public` parcels with a public-body owner, `n_in_reservation` parcels inside a reservation boundary, `acres_public` and `acres_private` by area overlap with the public-lands layer, and `n_indicators_failed` the number of coverage indicators the county fails in that export.

## Events by interval (read_series topic flow; twp_flow keyed `u`,`i`; county_flow keyed `county_n`,`i`)

### twp_flow|county_flow
Inferred events between consecutive exports. `created` parcels first seen; `acres_created`; by class `lot_created` (a new lot in an existing block), `block_created` (a new block), `unit_created` (a condominium unit inside an existing lot), `first_mapping` (coverage arriving: the quarter-section was empty before, not a real creation); `conf_high` and `conf_medium` creations by confidence tier; `is_subdivision` creations corroborated by a subdivision or certificate-of-survey name new at that interval; `divided` lots divided off: new lots where land was split in the quarter-section and the legal description names an instrument the parent land's did not, by `divided_plat` (a new plat or phase), `divided_amended` (an amended plat or replat) and `divided_cos` (a certificate of survey, as in family-transfer splits); re-descriptions with the same area are not counted. The count the Subdivision growth view uses. `persisted` parcels present at both ends; `owner_changed` persisting parcels whose normalised owner changed; `transfers_out_of_state` owner changes where the mailing state also changed (a sale to another state); `address_change_only` mailing-state changes with the same owner (an address edit, not a sale); `to_CA` and `from_CA` transfers into and out of California addresses; `comparable` = 1 when both ends of the interval are covered (rates are valid only then). Annualise with the interval's years.

## Other tables (read_table)

### county_owner_state
County by export by owner mailing state: `county_n`, `s`, `st` (index into the owner-origin state list), `parcels`, `acres`. Where out-of-state owners mail from.

### owner_state
One file per mailing state, township by export: `u`, `s`, `parcels`, `acres`, `private_parcels` owned from that state (read_series topic owner_state with state set; not delta-coded).

### reservation_stock
Reservation by export by tenure: `r` (index into the reservation list), `s`, `ten` (tenure code), `parcels`, `acres`. The checkerboard: the tribal-trust share of a reservation's acreage.

### absorption
Creation cohorts followed through time, for parcels whose creation was observed: `county_n`, `cohort` (export index at which the cohort's lots first appeared), `observed` (export index of the reading), `age_idx` = observed minus cohort, `years_elapsed`, `dev_stage` (0 platted only, 1 addressed, 2 built), `parcels`, `acres`. The built share of a cohort at an age is parcels at stage 2 over all stages at that cohort and age.

### absorption_survival
Time to an assessed building for every observed creation, with censoring: one row per `cohort` (export index at which the occurrence first appeared), `county_n` (0 statewide) and `age_idx` (snapshots since creation; `years` is the real elapsed time). `at_risk` lots still under observation and unbuilt at that age; `built` first built at that age; `gone` left the record unbuilt at that age (consolidated, retired or renumbered); `ended` records that stop there (the series end). `km_built` is the Kaplan-Meier share built treating leaving as censoring; `ci_built` the Aalen-Johansen share built with leaving as a competing outcome (the literal share of created lots built). A lot unbuilt at its last export is unbuilt so far, never "never built".

### size_histogram
Sizes of newly created parcels (first mappings excluded), statewide, by interval: `interval`, `bin_lo`, `bin_hi` (acres), `parcels`. Fine bins (0.5 acre to 50, 2 acres to 200, then coarse) for the threshold analysis.

### county_size_histogram
The same histogram by county over all intervals: `county_n`, `bin_lo`, `bin_hi`, `parcels`.

### threshold_edges
Lot creations around the statutory lines, by county and interval: `county_n`, `interval`, `lots` created; `below20`/`above20`, `below40`/`above40`, `below160`/`above160` = lots within the window just under and just over 20, 40 and 160 acres. A ratio of above to below well over 1 at 20 acres is lots sized to clear DEQ review; the 40- and 160-acre spikes are the PLSS survey grid.

### dormant
Dormant platted inventory per county (2026 export): `county_n`, `dormant_parcels` and `dormant_acres` at stage 0 five or more years after creation at any size, `median_age_years`; the residential-lot proxy `dormant_lt40ac` (lots under 40 acres), `dormant_lt40ac_acres`, `dormant_lt40ac_median_age`, `dormant_lt40ac_ge_5y`.

### dormant_by_size
Dormant parcels by county and `size_class` (a string: the acre band): `county_n`, `parcels`, `acres`.

### holdings_county
Large private holdings per county (0 = statewide) and export, after Haggerty et al. (2022): `private_acres`, `private_owners` (owner groups with private acreage), `large_acres` and `large_owners` (holdings of 640 acres or more, document tier), `large_mean` acres per large holding, `top4_acres`, `top1_acres`, `top2_acres`, `clo4` (top four large holdings' share of large-holding acreage, 0-1; null when fewer than four), `gap_1_2` = top1 minus top2; the maximal tier `large_acres_max`, `large_owners_max` (every pending review accepted); `large_oos_acres`, `large_oos_owners` large holdings mailed from out of state; `large_provisional`, `large_provisional_acres` large holdings resting on a pending identity decision; `large_token` with a name-token match only; `large_conflict` with a parcel the two public-land tests classify differently; `gini_private` (0-1) and `top1pct_share`, `top5pct_share`, `top10pct_share`, `top25pct_share`, `top50pct_share` (0-1) of private acreage, this dashboard's own measures; holding-size classes `n_lt640`, `ac_lt640`, `n_640_2560`, `ac_640_2560`, `n_2560_10k`, `ac_2560_10k`, `n_10k_50k`, `ac_10k_50k`, `n_gt50k`, `ac_gt50k`. The same concentration measures on the maximal tier (every pending identity decision accepted): `clo4_max`, `large_mean_max`, `gini_private_max`, `top1pct_share_max`, `top5pct_share_max`, `top10pct_share_max`, `top25pct_share_max`, `top50pct_share_max`; the tiers are two reconciliation procedures, not confidence bounds, and the gap between them is what a review could change.

### holdings_top
The ten largest holdings per county (0 = statewide) and export: `county_n`, `s`, `rank` 1-10, `acres`, `acres_if_merged` (reach if every pending review flag were accepted), `n_parcels`, `is_entity` (1 company, trust or public body; 0 a person), `review_status` (code list), `n_names` distinct owner names in the group, `pending_links`, and flags `strong` (a shared name or address needs a decision), `token` (name-token match), `conflict` (tenure tests disagree), `oos` (mailed from out of state). The columns `display_name`, `display_city`, `display_state` and `group_hash` are not available to you: refer to a holding by rank and size only.

### holdings_review
Large holdings by review status per county (0 = statewide) and export: `county_n`, `s`, `review_status`, `owners`, `acres`.

### regression_table1
The paper's Table 1 reproduced for its 13 counties at four exports: `county_n`, `s`, `T1_large_acres`, `T1_owners`, `T1_mean` (the paper's figures), `doc_large_acres`, `doc_owners`, `doc_mean` (document tier), `max_large_acres`, `max_owners` (maximal tier), `clo4`.

### cama_township|cama_county
The Department of Revenue's building records joined to the parcels at eight points (`s` is one of the eight export indexes; township rows keyed `u` and `county_n`, county rows keyed `county_n` with 0 statewide). `dwellings` parcels with a dwelling, `rated` with a condition rating, `n_dwell_total` dwellings including additional ones, `yb_median` median year built, `mh` manufactured homes, `condo_th` condominiums and townhouses, `partial` partly complete; `n_cd_none` and `n_cd0..7` by condition; `n_yb0..8` by year-built bin. Witness tests (each a count): `parcels_tested`, `improved_layer` (parcel layer says built), `struct_dor` (DOR has a structure), `agree_built`, `layer_only`, `dor_only`; address points (newest export only): `addr_tested`, `addr_hn_pt` house numbers with a point on the parcel, `addr_hn_nopt`, `addr_dw_res` dwellings with a residential point, `addr_dw_nores`. County rows add `addr_pt_nohn`, `addr_res_nodw`, `hn_dwell`, `hn_nodwell`, `nohn_dwell` (house number against dwelling), `dormant_lt40`, `dormant_dwell`, `dormant_struct`, `dormant_permit` (dormant lots that carry a dwelling, a structure or a permit), `stage1`, `stage1_dwell` (addressed-not-built parcels with a dwelling on record), `timing_n`, `timing_never`, `timing_ontime`, `timing_lag_median` (dwellings built 2004 on: when the ladder first showed a building, in rolls), `born_dwell`, `born_older` (new lots whose dwelling is older than the lot), `insp_recent` inspected within five years, `value_n`, `value_equal` (building values equal to the DOR's within a dollar).

### cama_timing
Year-built cohorts against the ladder, per county (0 statewide) and point: `county_n`, `s`, `yb` year built, `dwellings`, `never` (never shown built by the parcel layer), `earlier` (a value stood before the year built), `on_time`, `late1`, `late2plus` (rolls late), `address_before` (house number before the year built).

### cama_condition_decade
Condition by year-built bin per county (0 statewide) and point: `county_n`, `s`, `yb_bin` (year_built code), `cond` (condition code), `dwellings`.

### cama_transitions
The same dwellings rated at two consecutive points, per county (0 statewide): `county_n`, `s_from`, `s`, `n` followed, `same`, `worse`, `better`, `worse2plus`, `better2plus`, `yb_changed`.
