# Fixtures

Data uji deterministik untuk integration test (dimuat test, bukan migration).

Aturan:

- **Tidak boleh** berisi data customer asli, secret, atau dump production.
- Identifier sensitif memakai nilai dummy yang jelas palsu.
- Fixture per modul: `fixtures/<module>/*.json`.
