import json,os,sys,base64,urllib.request,urllib.error
name,prompt=sys.argv[1],sys.argv[2]
body={"model":"meta/muse-image","prompt":prompt,"n":1}
req=urllib.request.Request("https://openrouter.ai/api/v1/images",data=json.dumps(body).encode(),
 headers={"Authorization":"Bearer "+os.environ["OPENROUTER_API_KEY"],"Content-Type":"application/json"})
try: r=json.load(urllib.request.urlopen(req,timeout=600))
except urllib.error.HTTPError as e: print(name,"HTTP",e.code,e.read()[:500]); sys.exit(1)
d=(r.get("data") or [{}])[0]
if "b64_json" in d: data=base64.b64decode(d["b64_json"])
elif "url" in d:
    u=d["url"]; data=base64.b64decode(u.split(",",1)[1]) if u.startswith("data:") else urllib.request.urlopen(u,timeout=120).read()
else: print(name,"NO IMAGE",json.dumps(r)[:500]); sys.exit(1)
open(os.path.join(os.path.dirname(os.path.abspath(__file__)),name+".png"),"wb").write(data); print(name,"ok",len(data))
