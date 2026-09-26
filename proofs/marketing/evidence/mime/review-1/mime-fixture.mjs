const intent='a'.repeat(64),sender='sender@example.invalid',recipient='recipient@example.invalid';
export function payload({boundary='abc123',date='Fri, 25 Sep 2026 01:00:00 +0000',id='first',subject='Approved subject',text='Approved text',html='<p>Approved html</p>'}={}){
 const raw=['To: Synthetic <'+recipient+'>','From: Synthetic proof <'+sender+'>','Subject: '+subject,'X-Remold-Intent: '+intent,'MIME-Version: 1.0','Date: '+date,'Message-ID: <'+id+'@example.invalid>','Content-Type: multipart/alternative; boundary="'+boundary+'"','','--'+boundary,'Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: quoted-printable','',text,'--'+boundary,'Content-Type: text/html; charset=utf-8','Content-Transfer-Encoding: quoted-printable','',html,'--'+boundary+'--',''].join('\r\n');
 return {intent,sender,recipient,recipients:1,raw:Buffer.from(raw).toString('base64')};
}
