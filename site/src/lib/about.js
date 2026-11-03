/* ---------------------------------------------------------------------------
   about.js -- the About tab's prose, in one place.

   The page renders these sections as cards; the assistant's system prompt
   (scripts/build-prompt.mjs) carries the same text, minus the sections that
   describe the controls (the tools describe those) and the contact card, so
   what the reader is told and what the assistant is told cannot drift
   apart. Pure: given the dimension tables, returns strings.
--------------------------------------------------------------------------- */
export const CONTACT_URL = 'https://www.epistemegeospatial.com/contact';

/** @returns {{key: string, title: string, html: string, prompt: boolean}[]}
 *  `prompt` says whether the section goes into the assistant's instructions. */
export function aboutSections(dim, meta) {
  const nSnaps = dim.snapshots.length;
  const first = dim.snapshots[0].date, last = dim.snapshots[nSnaps - 1].date;
  return [
    { key: 'what', title: 'What this is', prompt: true, html: `
      <p>Montana’s cadastral parcel layer, exported ${nSnaps} times between ${first} and ${last}
      by the Montana State Library from the Department of Revenue’s records, read parcel by parcel
      and compared vintage to vintage. Each export is a snapshot of every parcel in the state;
      the differences between snapshots are the events: parcels created and retired, owners
      changed, buildings assessed. Statistics are aggregated to ${meta.townships.toLocaleString()}
      PLSS townships and ${meta.counties} counties, and the newest export’s parcels themselves
      (about 887,000) are drawn once the map is zoomed past level 10. Beside the parcel layer, the Department
      of Revenue’s own building records, from three exports of its ORION appraisal database, are joined to the
      parcels at eight tax years (2014, 2015 to 2018 and 2024 to 2026): the condition and age of the housing
      stock, and a second check on what the parcel layer says is built. The map at parcel depth is today’s
      parcel fabric carrying historical attributes and first-seen outlines, not a reconstruction of the fabric
      at an earlier date; the township and county series are the historical record.</p>
      <p>It was built by <a href="https://www.epistemegeospatial.com/">Episteme Geospatial</a> as a
      working instrument for the questions the cadastral record can answer: where land is being
      divided, who owns it and from where, what has actually been built on it, and how concentrated
      large private holdings have become.</p>` },
    { key: 'how', title: 'How to use it', prompt: false, html: `
      <ul>
        <li><strong>Tabs</strong> choose a view. Each view paints the map and fills this panel with its charts.</li>
        <li><strong>The snapshot slider</strong> picks a vintage; the map, the tiles of numbers and the charts’
          cursor follow it. The date shown is the export date, not an assessment date. The Condition view has
          building records at eight of the vintages and shows the nearest one at or before the slider.</li>
        <li><strong>Unit</strong> switches the aggregate surface between PLSS townships and counties.
          <strong>Measure</strong> switches between parcels and acres where a view supports both.</li>
        <li><strong>Click a unit</strong> on the map to focus every chart on it; shift-click adds units;
          <em>Clear selection</em> returns to the statewide figures. The key in the map’s corner names what is painted.</li>
        <li><strong>Mask low coverage</strong> greys out units whose record is not yet complete in that vintage;
          the early years arrived county by county.</li>
        <li><strong>Zoom in.</strong> Past level 10 the aggregate surface gives way to the parcels, coloured by the
          view’s parcel key. Click a parcel for its geocode and attributes; no owner information is shown.
          Parcels that did not yet exist at the selected vintage are outlined by the period in which they first
          appeared (2003 to 2005, 2006 to 2010, 2011 to 2015, 2016 to 2020, 2021 on), so the 2003 layer shows the
          whole subdivision history at once and each later vintage what was still to come. Parcels first seen in
          or before the vintage a county’s record arrived are that county’s baseline and are not outlined.</li>
        <li><strong>Layers</strong> adds the township grid, county boundaries, roads with their names, building
          footprints (the 2018 statewide set, with lidar footprints where flown), reservations, public lands and city limits. Under Parcels, the fill can be switched off to leave only the parcel lines and the period outlines. The basemap is outlines only;
          the basemap menu offers an in-house Montana basemap built from the State Library’s frameworks (roads, water,
          places, buildings and address points, served from this site) and an OpenStreetMap one; only the latter
          fetches anything from a third party.</li>
        <li><strong>Reports</strong> composes a printable document from the same tables: a county profile, a
          housing condition profile, a statewide trends brief, a large-holdings update in the form of the paper, a
          review worksheet as a CSV, and a subdivision-activity report for a chosen period. <em>Save as PDF</em> hands the page to the browser’s print
          dialog, where “Save as PDF” is the destination; nothing leaves the browser.</li>
        <li>The <strong>◐</strong> button toggles light and dark.</li>
        <li><strong>Ask</strong>, where it appears, opens an assistant that sets the dashboard and answers from the
          same tables. Your question, its replies and a description of what the dashboard shows are sent to
          Anthropic’s API through this site’s server; nothing else about you is sent, and no owner names are. It
          reports only figures it read from the published tables, with the export date, and never names an owner;
          check anything that matters against the view it opens.</li>
      </ul>` },
    { key: 'reading', title: 'Reading the views', prompt: true, html: `
      <p><strong>Development.</strong> Every parcel sits on a three-step ladder: <em>platted only</em> (no situs
      address, no assessed building), <em>addressed</em> (a house number but no building value) and <em>built</em>
      (an assessed building). The map shows the share of parcels addressed but unbuilt, the gap between
      infrastructure and houses. The charts follow the ladder over time, the <em>absorption</em> of each creation
      cohort (of the lots created at a vintage, the share carrying a building N years later) and the
      <em>dormant inventory</em> (lots under 40 acres that have sat at the bottom of the ladder five years or more).
      Dedicated common areas (open space, parks, HOA and condominium tracts) are counted apart and never climb.</p>
      <p><strong>Condition.</strong> The Department of Revenue’s own building records, from its ORION appraisal
      database, joined to the parcels on the geocode at eight tax years: the condition of the principal dwelling on
      the DOR’s scale from Unsound (1) to Excellent (10), the earliest year built, and the same dwellings followed
      from point to point. Through tax year 2014 the DOR filled CDU, the composite rating its dictionary describes;
      at the 2015 reappraisal it retired the composite by copying it into four components and has rated them apart
      since, so the rating is CDU for 2014 and the physical-condition component after, and the view says which. The map
      draws condition and age together as one grid of nine colours, condition across and age up: thirds of the units
      shown at township and county grain, fixed classes on the parcels (fair or worse, average, good or better; before
      1980, 1980 to 2004, 2005 on). The
      same records are an independent witness to the ladder, and the view reports each test with a count on both
      sides at every point: whether a parcel the layer calls built has a structure on record, how soon after a
      dwelling’s year built the ladder first showed a value, whether a dormant lot carries a dwelling after all.</p>
      <p><strong>Ownership.</strong> Tenure (public domain, tribal trust, private) and the owner’s distance from
      the land (the same place, the same county, elsewhere in Montana, out of state), both read from the mailing
      address on the record. The map shows the out-of-state share; the charts add the trust-and-fee checkerboard
      inside each reservation and where out-of-state owners mail from.</p>
      <p><strong>Fragmentation.</strong> Acreage by parcel-size class, the share of acreage in parcels under 40
      acres on the map, and agricultural-use acreage.</p>
      <p><strong>Churn.</strong> How often parcels that persist from one vintage to the next change owner, per
      year; transfers against address-only edits; and condominiumisation.</p>
      <p><strong>Thresholds.</strong> The sizes of newly created parcels against the acreage lines in Montana’s
      subdivision law. A pile-up just above a line is lots sized to clear it; the map shows new lots per
      thousand parcels per year, and the era filter narrows the period.</p>
      <p><strong>Holdings.</strong> A <em>holding</em> is one owner’s consolidated private acreage within a county;
      <em>large</em> means 640 acres or more, one section. The map shows the four-property concentration ratio
      (CLO4): the share of a county’s large-holding acreage held by its four largest. The charts count large
      owners and their acreage, rank counties, class holdings by size, draw the Lorenz curve and Gini, and compare
      the result with the published Table 1. Owners are identified by mailing address, with bridges for entities
      and couples, and two tiers (document and maximal) bound what a manual review could change.</p>
      <p><strong>Review.</strong> The method expects a reviewer. This view shows what one would decide: large
      holdings that rest on an unmade decision (an entity merge, a token name, a pending match, an ORION bridge),
      parcels on which the two public-land tests disagree, and how a decision is recorded.</p>` },
    { key: 'sources', title: 'Where the analyses come from', prompt: true, html: `
      <p>The holdings and review analyses follow Haggerty, Epstein, Gosnell, Rose and Stone (2022),
      <em>Rural Land Concentration &amp; Protected Areas: Recent Trends from Montana and Greater Yellowstone</em>,
      Society &amp; Natural Resources 35(6): 692–700,
      <a href="https://doi.org/10.1080/08941920.2022.2038318">doi:10.1080/08941920.2022.2038318</a>, and the
      consolidation methodology in its supplement. The Holdings view reports this dashboard’s residuals against
      that paper’s Table 1 so the reproduction can be judged.</p>
      <p>The development ladder, absorption, dormant inventory, churn and threshold analyses were constructed for
      this dashboard from the same records, and the condition series and the witness tests from the Department of
      Revenue’s building records. Each card’s caption states its definition, and the measured decisions behind them
      are kept in the project’s findings log.</p>
      <p>Data: the Montana Cadastral Framework (Montana State Library and Department of Revenue), ${nSnaps}
      exports from ${first} to ${last}; the Montana Public Lands layer (State Library, 2026) for public domain by
      area; reservations and incorporated cities (State Library); the Transportation Framework road centerlines
      (State Library and Department of Transportation, June 2026); building footprints (Microsoft US Building
      Footprints, 2018 release, ODbL, as redistributed by the State Library, merged with the State Library’s lidar
      building footprints, 37 project areas); the Structures Framework’s address points (State Library, exported
      2026-10-30), as a witness to the address rung and in the in-house basemap, which also draws the NHD
      hydrography, GNIS place names, county and city boundaries and public lands (State Library); and the Department of Revenue’s ORION appraisal database in three exports (refreshed
      2016-03-27, 2018-06-21 and 2026-06-24), for the building records behind the Condition view and the party
      identifiers that bridge owners in the 2024 to 2026 vintages.</p>` },
    { key: 'caveats', title: 'Caveats', prompt: true, html: `
      <ul>
        <li>Vintages are export dates. 2002 is excluded (it lacks the counties where parcels are created) and no
          2012 or 2015 export exists, so events spanning those gaps are dated to the interval.</li>
        <li>Coverage arrived county by county through 2007; the comparable series begins in
          ${meta.comparable_series_begins}. The coverage mask is on by default for that reason.</li>
        <li>The 2009-07-05 export ships its value and agricultural columns entirely zero. Improvement status and
          agricultural acreage are unknown there, not zero, and that vintage is left out of the charts that need them.</li>
        <li>The ladder is probabilistic: a parcel with a house number carries an assessed building 89 to 91% of the
          time, and some parcels carry a building with no house number. Checked against the Department of Revenue’s
          building records, the parcel layer and the appraiser agree on whether a parcel is built on 99.5 to 99.7%
          of parcels in every tax year tested.</li>
        <li>The State Library’s address points are a third record: on the newest export they agree with the parcel
          layer’s house number on 92% of parcels, place a residential point on 94% of parcels with a dwelling on
          record, and their own geocode names the parcel that contains them 98.7% of the time. A multi-unit
          building is usually one point. The framework has no history, so only the newest point carries the test.</li>
        <li>Condition and year built are the appraiser’s record at eight tax years, not a continuous series, and
          a rating is as current as the last inspection. An export dated January or February carries the previous
          year’s roll, so a dwelling built in one year enters the ladder in the first export after the middle of the
          next; the Condition view states the test in those terms.</li>
        <li>Owner location is a mailing address, not a residence.</li>
        <li>A geocode is an identifier, not a parcel. The Department of Revenue reissues retired numbers; a number
          that returns after a gap is counted as a new parcel from its return${meta.lineage && meta.lineage.resurrected_ids != null
            ? ` (${Number(meta.lineage.resurrected_ids).toLocaleString()} such identifiers over the series)` : ''}.</li>
        <li>Each source speaks for its own time. The parcel exports are observed on their dates; the public-lands
          layer is a 2026 classification applied to every year, so tenure by area describes the parcels inside what
          is public land today; the building records are observed at their tax years. The table below the caveats
          says what each input supports.</li>
        <li>A lot unbuilt at its last export is unbuilt so far, not never: the absorption curves are right-censored,
          and the censored estimate (counting lots that left the record as a competing outcome) is given on the
          Development view.</li>
        <li>Public domain comes from one 2026 public-lands layer applied to every year, decided by area overlap;
          tribal trust comes from owner names, because trust land is absent from that layer. A reservation boundary
          is jurisdiction, not ownership.</li>
        <li>Owner identity follows the method’s address key. No manual review has been performed; the Review view
          shows the range a reviewer could move, and nothing is assumed in either direction.</li>
        <li>Dedicated common areas are flagged by rule (the Non-Valued property type inside a subdivision, an
          association or tract-named owner, or an open-space phrase in the legal description of an unbuilt parcel);
          the rule touches 7.7% of platted-only subdivision lots under 40 acres and 0.3% of built parcels.</li>
        <li>The parcels drawn are the newest export’s. A parcel split later shows as its pieces at every date;
          the magenta outline is the one thing on the parcel map that follows the slider.</li>
        <li>Parcel geometry is generalised for the tiles (about 2.4 m). Building footprints are Microsoft’s 2018
          computer-generated set, which carries 79% of the parcels with an appraised dwelling statewide (89% of those
          built before 2015, 11% of those built in 2018 or later), overlaid with the State Library’s lidar footprints
          where lidar has flown, an eighth of the state; together 82% statewide and about 91% inside the flown areas.
          A 2018 footprint inside a flown area that the lidar did not see is drawn lighter. Roads are as of June 2026.</li>
        <li>Agricultural-use acreage is clamped to each parcel’s own area, since some exports report more
          agricultural acres than mapped acres.</li>
        <li>No parcel-level owner information is published. The largest holdings are named from the public
          cadastral record.</li>
      </ul>` },
    { key: 'contact', title: 'Questions and comments', prompt: false, html: `
      <p>This dashboard is a project of <a href="https://www.epistemegeospatial.com/">Episteme Geospatial</a>.
      Comments, corrections and questions are welcome through the
      <a href="${CONTACT_URL}">contact page</a>.</p>` },
  ];
}
