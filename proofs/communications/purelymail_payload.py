"""Exact authorized fixture payload contract, with no credentials or networking."""
import re


def validate_send(message, verified_p1_reference=None):
    match = re.fullmatch(r'<remold-p5-([a-f0-9-]{36})-(P1|Q1|reply-P|Q2|Q3)@repliedfor.com>', message['messageId'])
    assert match
    run, name = match.groups()
    assert message['name'] == name
    a, b = 'shakur@envoylogic.com', 'reply@repliedfor.com'
    assert (message['from'], message['to']) == ((a, b) if name == 'P1' else (b, a))
    expected_subject = ('Re: ' if name == 'reply-P' else '') + f'Remold P5 test {run} {"P" if name in ("P1", "reply-P") else "Q"}'
    assert message['subject'] == expected_subject
    expected_reply = None if name in ('P1', 'Q1') else f'<remold-p5-{run}-{"P1" if name == "reply-P" else "Q1"}@repliedfor.com>'
    if name == 'reply-P' and verified_p1_reference is not None:
        assert re.fullmatch(r'<[A-Za-z0-9_=+./-]+@mail\.gmail\.com>', verified_p1_reference)
        expected_reply = verified_p1_reference
    assert message.get('inReplyTo') == expected_reply
    assert isinstance(message['text'], str) and 0 < len(message['text']) <= 2000
    assert not any('\r' in message[key] or '\n' in message[key] for key in ('from', 'to', 'subject', 'messageId'))
    return True
