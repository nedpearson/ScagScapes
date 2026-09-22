# Reproduces the road factor and speed bands in supabase/functions/ss-api/routing.ts.
# Run: python3 tools/measure-road-factor.py   (hits the OSRM public demo server, ~1 request)
# Last run 2026-09-21: n=26, median ratio 1.231, median 36.1 mph. Port Allen crossings 2.49-2.65x.
import json,urllib.request,random,math,statistics,time
UA={"User-Agent":"ScagScapesCommand/1.6 measurement (ops@scagscapes.com)","Accept":"application/json"}
SHOP=(30.4515,-91.1871)
# Real Baton Rouge metro destinations: supplier/vendor-type locations across the market the app serves.
DEST=[
 ("Home Depot Airline Hwy BR",30.4419,-91.0479),("Home Depot Siegen Ln BR",30.3860,-91.0407),
 ("Sunbelt Rentals BR Airline",30.4784,-91.0714),("United Rentals BR",30.4436,-91.1268),
 ("Herc Rentals BR",30.4993,-91.1449),("SiteOne Landscape BR",30.4290,-91.0930),
 ("Lowe's Port Allen",30.4530,-91.2160),("Port Allen center",30.4505,-91.2101),
 ("Prairieville center",30.3005,-90.9540),("Gonzales center",30.2388,-90.9201),
 ("Denham Springs",30.4866,-90.9556),("Zachary",30.6491,-91.1565),
 ("Baker",30.5885,-91.1682),("Central LA",30.5546,-91.0370),
 ("Plaquemine",30.2888,-91.2340),("Addis",30.3513,-91.2646),
 ("St Gabriel",30.2560,-91.1023),("Brusly",30.3949,-91.2529),
 ("Walker LA",30.4890,-90.8612),("Geismar",30.2199,-91.0090),
 ("LSU campus",30.4133,-91.1800),("BR Metro Airport",30.5332,-91.1496),
 ("Kenworth of LA BR",30.5240,-91.1330),("Doggett Machinery BR",30.4620,-91.0180),
 ("Southern Tire Mart BR",30.4980,-91.1810),("Pirtek BR",30.4390,-91.0700),
]
def crow(a,b,c,d):
    R=3958.8;dla=math.radians(c-a);dlo=math.radians(d-b)
    x=math.sin(dla/2)**2+math.cos(math.radians(a))*math.cos(math.radians(c))*math.sin(dlo/2)**2
    return R*2*math.atan2(math.sqrt(x),math.sqrt(1-x))
coords=";".join([f"{SHOP[1]},{SHOP[0]}"]+[f"{d[2]},{d[1]}" for d in DEST])
dests=";".join(str(i+1) for i in range(len(DEST)))
url=f"https://router.project-osrm.org/table/v1/driving/{coords}?sources=0&destinations={dests}&annotations=duration,distance"
j=json.load(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=30))
assert j["code"]=="Ok", j
ratios=[];speeds=[];rows=[]
for i,d in enumerate(DEST):
    m=j["distances"][0][i]; s=j["durations"][0][i]
    if m is None or s is None: continue
    road=m/1609.344; cw=crow(SHOP[0],SHOP[1],d[1],d[2])
    if cw<0.5: continue
    r=road/cw; mph=road/(s/3600)
    ratios.append(r);speeds.append(mph)
    rows.append((d[0],round(cw,1),round(road,1),round(r,2),round(s/60),round(mph,1)))
rows.sort(key=lambda x:x[1])
for r in rows: print(f"{r[0]:<26} crow {r[1]:>5} rd {r[2]:>5} ratio {r[3]:>4}  {r[4]:>3}min  {r[5]:>5} mph")
print()
print("n =",len(ratios))
print("ratio  median %.3f  mean %.3f  p25 %.2f  p75 %.2f"%(statistics.median(ratios),statistics.mean(ratios),statistics.quantiles(ratios,n=4)[0],statistics.quantiles(ratios,n=4)[2]))
print("mph    median %.1f  mean %.1f"%(statistics.median(speeds),statistics.mean(speeds)))
