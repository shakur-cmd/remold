"""Authorized counterpart connectivity only. Never fetch mail or send SMTP mail."""
import datetime
import hashlib
import imaplib
import json
from pathlib import Path
import smtplib
import ssl

KEYS = {"IMAP_USER", "IMAP_PASS", "IMAP_HOST", "IMAP_PORT",
        "SMTP_USER", "SMTP_PASS", "SMTP_HOST", "SMTP_PORT"}
SOURCE = Path("/Users/urkel/Documents/CodeMyVibe/Projects/review-replies/.env")
OUTPUT = Path(__file__).parent / "evidence/purelymail-connection.json"


def credentials():
    values = {}
    for line in SOURCE.read_text().splitlines():
        name, sep, value = line.strip().partition("=")
        if sep and name in KEYS:
            values[name] = value.strip().strip("\"'")
    for protocol, host, port in (("IMAP", "imap.purelymail.com", "993"),
                                 ("SMTP", "smtp.purelymail.com", "465")):
        assert values.get(protocol + "_USER") == "reply@repliedfor.com"
        assert values.get(protocol + "_HOST") == host
        assert values.get(protocol + "_PORT") == port
        assert values.get(protocol + "_PASS")
    return values


result = {"checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
          "level": "LIVE counterpart connectivity only", "mailbox": "reply@repliedfor.com",
          "actualMailSent": 0, "messageBodiesFetched": 0, "calendarCalls": 0,
          "twoGoogleMailboxesProven": False, "credentialValuesRecorded": False,
          "sourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          "primarySource": "https://support.purelymail.com/support/solutions/articles/159000430778-server-settings-imap-smtp-and-pop3"}
stage = "credential_contract"
try:
    config = credentials()
    context = ssl.create_default_context()
    stage = "imap_tls_login"
    with imaplib.IMAP4_SSL(config["IMAP_HOST"], int(config["IMAP_PORT"]),
                          ssl_context=context, timeout=20) as client:
        client.login(config["IMAP_USER"], config["IMAP_PASS"])
        result["imap"] = {"authenticated": True, "tls": client.sock.version(),
                          "certificateVerified": True}
        stage = "imap_read_only_baseline"
        status, _ = client.select("INBOX", readonly=True)
        assert status == "OK"
        baseline = {}
        for key in ("UIDVALIDITY", "UIDNEXT"):
            _, data = client.response(key)
            assert data and data[0] and data[0].isdigit()
            baseline[key.lower()] = int(data[0])
        result["imap"].update({"readOnly": True, "baseline": baseline,
                               "commands": ["CAPABILITY", "LOGIN", "EXAMINE", "LOGOUT"]})
    stage = "smtp_tls_auth"
    with smtplib.SMTP_SSL(config["SMTP_HOST"], int(config["SMTP_PORT"]),
                          context=context, timeout=20) as client:
        assert client.ehlo()[0] == 250
        code, _ = client.login(config["SMTP_USER"], config["SMTP_PASS"])
        assert code == 235
        result["smtp"] = {"authenticated": True, "tls": client.sock.version(),
                          "certificateVerified": True, "authCode": code,
                          "commands": ["EHLO", "AUTH", "QUIT"], "mailCommands": 0}
    result["status"] = "PASS"
except Exception as error:
    # Provider messages can contain account information; retain only type and stage.
    result.update(status="FAIL", failedStage=stage, errorType=type(error).__name__)
OUTPUT.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
raise SystemExit(0 if result["status"] == "PASS" else 1)
