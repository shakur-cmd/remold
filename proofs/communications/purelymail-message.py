"""Bounded test transport. Called only after the Node ledger reserves an attempt."""
import email
from email.message import EmailMessage
from email import policy
import imaplib
import json
from pathlib import Path
import smtplib
import ssl
import sys

ALLOWED = {"SMTP_USER", "SMTP_PASS", "SMTP_HOST", "SMTP_PORT", "IMAP_USER", "IMAP_PASS", "IMAP_HOST", "IMAP_PORT"}
from purelymail_payload import validate_send
request = json.load(sys.stdin)
if request.get('action') in ('validate-plan', 'validate-resume'):
    try:
        resumed = request['action'] == 'validate-resume'
        names = ['reply-P', 'Q2', 'Q3'] if resumed else ['P1', 'Q1', 'reply-P', 'Q2', 'Q3']
        assert [message['name'] for message in request['messages']] == names
        for message in request['messages']:
            validate_send(message, request.get('verifiedP1Reference'))
        print(json.dumps({'ok': True, 'validated': len(names), 'providerCalls': 0}))
        sys.exit(0)
    except Exception:
        print(json.dumps({'ok': False, 'error': 'INVALID_TEST_PAYLOAD', 'providerCalls': 0}))
        sys.exit(1)
values = {}
for line in Path('/Users/urkel/Documents/CodeMyVibe/Projects/review-replies/.env').read_text().splitlines():
    name, sep, value = line.strip().partition('=')
    if sep and name in ALLOWED:
        values[name] = value.strip().strip("\"'")
result = {"ok": False}
try:
    assert values['SMTP_USER'] == values['IMAP_USER'] == 'reply@repliedfor.com'
    assert values['SMTP_HOST'] == 'smtp.purelymail.com' and values['SMTP_PORT'] == '465'
    assert values['IMAP_HOST'] == 'imap.purelymail.com' and values['IMAP_PORT'] == '993'
    message_id = request['messageId']
    verified = request.get('verifiedP1Reference')
    if request['action'] == 'read-test' and verified == message_id:
        import re
        assert re.fullmatch(r'<[A-Za-z0-9_=+./-]+@mail\.gmail\.com>', message_id)
    else:
        assert message_id.startswith('<remold-p5-') and message_id.endswith('@repliedfor.com>')
        assert all(c.isalnum() or c in '<>@._-' for c in message_id)
    context = ssl.create_default_context()
    if request['action'] == 'send':
        assert request['from'] == 'reply@repliedfor.com' and request['to'] == 'shakur@envoylogic.com'
        validate_send(request, request.get('verifiedP1Reference'))
        message = EmailMessage()
        for header, key in [('From', 'from'), ('To', 'to'), ('Subject', 'subject'), ('Message-ID', 'messageId')]:
            message[header] = request[key]
        if request.get('inReplyTo'):
            message['In-Reply-To'] = request['inReplyTo']
            message['References'] = request['inReplyTo']
        message.set_content(request['text'])
        with smtplib.SMTP_SSL(values['SMTP_HOST'], 465, context=context, timeout=20) as client:
            client.login(values['SMTP_USER'], values['SMTP_PASS'])
            refused = client.send_message(message)
            assert not refused
        result = {'ok': True, 'accepted': True, 'messageId': message_id}
    elif request['action'] == 'read-test':
        baseline = request['baseline']
        with imaplib.IMAP4_SSL(values['IMAP_HOST'], 993, ssl_context=context, timeout=20) as client:
            client.login(values['IMAP_USER'], values['IMAP_PASS'])
            assert client.select('INBOX', readonly=True)[0] == 'OK'
            assert int(client.response('UIDVALIDITY')[1][0]) == baseline['uidvalidity']
            code, found = client.uid('SEARCH', None, 'UID', str(baseline['uidnext']) + ':*', 'HEADER', 'Message-ID', '"' + message_id + '"')
            assert code == 'OK'
            matches = []
            for uid in found[0].split():
                if int(uid) < baseline['uidnext']:
                    continue
                code, data = client.uid('FETCH', uid, '(BODY.PEEK[])')
                assert code == 'OK'
                raw = next(part[1] for part in data if isinstance(part, tuple))
                message = email.message_from_bytes(raw, policy=policy.default)
                assert str(message['Message-ID']) == message_id
                matches.append({'messageId': message_id, 'from': str(message['From']), 'to': str(message['To']), 'uid': int(uid)})
            result = {'ok': True, 'messages': matches, 'readOnly': True}
    else:
        raise ValueError()
except Exception as error:
    result = {'ok': False, 'errorType': type(error).__name__, 'outcome': 'unknown'}
print(json.dumps(result))
sys.exit(0 if result['ok'] else 1)
