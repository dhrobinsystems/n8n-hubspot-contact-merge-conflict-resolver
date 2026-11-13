# ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts provided in this repository (`n8n-hubspot-contact-merge-conflict-resolver`) are for educational and architectural demonstration purposes.

* **No Liability:** The author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, or consequential damages resulting from the use, misuse, or deployment of these scripts. This includes lost, overwritten or incorrectly merged CRM records.
* **No Warranty:** All software, n8n JSON blueprints, and JavaScript modules are provided "AS IS", without warranty of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, or non-infringement.
* **Merges Are Permanent:** Treat every HubSpot contact merge as irreversible. Records merged through the API cannot be reliably split back into their originals. Keep `DRY_RUN=true` until you have reviewed the audit log of planned merges and agree with every decision.
* **Production Testing Required:** Always test thoroughly in an isolated staging environment (for example a HubSpot developer test account or sandbox) with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled before connecting live HubSpot credentials.
* **Third-Party APIs & Compliance:** Users are solely responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR/CCPA), and security policies of HubSpot and any connected services. That includes confirming a lawful basis for combining personal data from separate records, honouring consent and subscription preferences carried by every record merged, and reviewing every automated merge and property overwrite.

## License

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](LICENSE).
