"""ClinicalTrials.gov retrieval via the official public API (v2).

Free public API, no key or scraping. We request only the few metadata fields
we display and fail soft so a trials outage never breaks the main flow.
"""
from __future__ import annotations

import httpx

CTGOV = "https://clinicaltrials.gov/api/v2/studies"
_FIELDS = ",".join(
    [
        "protocolSection.identificationModule.nctId",
        "protocolSection.identificationModule.briefTitle",
        "protocolSection.statusModule.overallStatus",
        "protocolSection.designModule.phases",
        "protocolSection.conditionsModule.conditions",
    ]
)


def _parse(study: dict) -> dict:
    ps = study.get("protocolSection", {})
    idm = ps.get("identificationModule", {})
    status = ps.get("statusModule", {})
    design = ps.get("designModule", {})
    conditions = ps.get("conditionsModule", {})
    nct_id = idm.get("nctId", "")
    phases = design.get("phases") or []
    # Drop the uninformative "NA" phase marker.
    phases = [p for p in phases if p and p != "NA"]
    return {
        "nct_id": nct_id,
        "title": idm.get("briefTitle", ""),
        "status": status.get("overallStatus", ""),
        "phases": phases,
        "conditions": (conditions.get("conditions") or [])[:4],
        "url": f"https://clinicaltrials.gov/study/{nct_id}" if nct_id else "",
    }


async def find_trials(term: str, limit: int = 10) -> list[dict]:
    params = {"query.term": term, "pageSize": str(limit), "fields": _FIELDS}
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(CTGOV, params=params, timeout=20)
            r.raise_for_status()
            studies = r.json().get("studies", [])
    except (httpx.HTTPError, ValueError):
        return []
    return [_parse(s) for s in studies if s.get("protocolSection")]
