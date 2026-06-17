// G0 anchor fixture: nothing here retrieves a corpus pattern. No design-system
// import (no R1 component overlap), no static finding (no R2 SC), and a neutral
// path with no journey hint (no R3). The retrieved slice is therefore empty, so
// the G0 anchor must veto every nomination — no grounding, no flag.
export const Plain = () => <section>content</section>;
