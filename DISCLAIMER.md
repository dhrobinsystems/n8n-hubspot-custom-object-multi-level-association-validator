# ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts in this repository (**n8n-hubspot-custom-object-multi-level-association-validator**) are provided for educational and architectural demonstration purposes.

**No Liability:** The author and dhRobin Systems accept no responsibility or liability for any direct, indirect, incidental, or consequential damages that result from using, misusing, or deploying these scripts. This includes, without limitation:
- associations that are created, archived or left in place incorrectly;
- record properties that are overwritten;
- broken reports, workflows, sequences or integrations that depend on association structure;
- HubSpot API rate-limit penalties or plan overage charges;
- lost or corrupted CRM data;
- decisions made on the basis of audit results.

**No Warranty:** All software, n8n JSON blueprints, JavaScript modules, fixtures and documentation are provided "AS IS", without warranty of any kind, express or implied. This includes, but is not limited to, warranties of merchantability, fitness for a particular purpose, and non-infringement. Nothing here guarantees that every orphaned record, dangling link or label mismatch will be found, or that a record flagged as broken really is broken. Search limits, pagination caps, index lag, archived records, permissions and concurrent edits can all produce incomplete or misleading results.

**Production Testing Required:** Always test thoroughly in an isolated staging environment, such as a HubSpot developer test account or sandbox, with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled, before you connect live HubSpot credentials. Run the offline simulator (`node scripts/simulate-sandbox-run.js`) after every change to the workflow.

Before you enable any remediation action:
- review the dry-run preview for that portal;
- export or back up the affected objects and associations;
- enable one action at a time, starting with `flag_records`.

Treat every finding as a lead that a person must confirm in HubSpot before it is acted on. `create_missing_association` and `archive_dangling_association` change the structure of your CRM and may not be easy to reverse.

**Third-Party APIs & Compliance:** You alone are responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR/CCPA), and security policies of HubSpot, Slack, and any connected services. That includes:
- granting the private app only the scopes it needs (`crm.objects.custom.read`, `crm.objects.custom.write`, `crm.schemas.custom.read`), and removing write scope when you only need audits;
- confirming you have a lawful basis and internal authorisation to read and modify the records being audited;
- keeping personal data out of Slack alerts, ops webhooks and exported reports, and limiting who can see them;
- honouring your organisation's change-management, data-retention and audit-trail requirements for automated CRM changes;
- reviewing every automatically created, archived or updated association and record;
- rotating any token that is ever exposed in logs, screenshots, exports or version control.

**Not Legal or Compliance Advice:** Nothing in this repository is legal, compliance or data-governance advice. Consult qualified professionals about data protection obligations in your jurisdiction.

**Synthetic Data Only:** All company, project and asset names, record IDs, portal IDs, object type IDs, association type IDs and URLs in this repository are fictional placeholders (for example "ParentCorp Inc", "ChildProject A", "AssetUnit X", portal `99000001`, type IDs `901`–`904`, `*.example.com`). Any resemblance to real organisations or schemas is coincidental.

The full disclaimer is also referenced from README.md.

## License

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](LICENSE).

---

Full text: DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 DH Robin (dhRobin Systems) · Provided as-is, see the disclaimer.
