"""Independent stdlib oracle for the bounded, ASCII multipart proof fixture."""
import base64
import email
import email.policy
import email.utils
import hashlib
from html.parser import HTMLParser
from urllib.parse import urlsplit
import json
import re
import sys

payload = json.load(sys.stdin)
raw = base64.b64decode(payload['raw'], validate=True)
message = email.message_from_bytes(raw, policy=email.policy.default)
assert not any(part.defects for part in message.walk()), 'Malformed MIME'
assert message.get_content_type() == 'multipart/alternative'
assert [part.get_content_type() for part in message.iter_parts()] == ['text/plain', 'text/html']
for field, expected in [('To', payload['recipient']), ('From', payload['sender'])]:
    assert len(message.get_all(field, [])) == 1
    assert email.utils.getaddresses(message.get_all(field)) == [(email.utils.parseaddr(message[field])[0], expected)]
assert message['X-Remold-Intent'] == payload['intent']
assert not message.get_all('Cc') and not message.get_all('Bcc')
wire = raw.decode('ascii')
header_block, body = wire.split('\r\n\r\n', 1)
headers = re.split(r'\r\n(?![ \t])', header_block)
boundary = message.get_boundary()
assert re.fullmatch(r'[A-Za-z0-9_-]{1,70}', boundary)
stable = []
for header in headers:
    name = header.split(':', 1)[0].lower()
    if name in ['date', 'message-id']:
        continue
    if name == 'content-type':
        header, count = re.subn(r'(boundary="?)' + re.escape(boundary) + r'(?="|$)', r'\1REMOLD_BOUNDARY', header)
        assert count == 1
    stable.append(header)
start, end = '--' + boundary + '\r\n', '\r\n--' + boundary + '--\r\n'
assert body.startswith(start) and body.endswith(end)
parts = body[len(start):-len(end)].split('\r\n--' + boundary + '\r\n')
assert len(parts) == 2
normalized = json.dumps(dict(sender=payload['sender'], recipient=payload['recipient'], headers='\r\n'.join(stable), parts=parts), separators=(',', ':'), ensure_ascii=False)
html = message.get_body(preferencelist=('html',)).get_content()
class Images(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []
    def handle_starttag(self, tag, attrs):
        if tag == 'img':
            self.urls.extend(value for name, value in attrs if name == 'src' and value)
images = Images()
images.feed(html)
urls = [url for url in images.urls if re.fullmatch(r'/email/[a-zA-Z0-9]+\.gif', urlsplit(url).path)]
assert len(urls) == 1, 'Exactly one native tracking pixel required'
pixels = [re.fullmatch(r'/email/([a-zA-Z0-9]+)\.gif', urlsplit(urls[0]).path)[1]]
print(json.dumps(dict(intent=payload['intent'], sender=payload['sender'], recipient=payload['recipient'], hash=hashlib.sha256(normalized.encode()).hexdigest(), rawSha256=hashlib.sha256(raw).hexdigest(), bytes=len(raw), pixel=urls[0], tracking=pixels[0], mimeDefects=0, parts=2)))
