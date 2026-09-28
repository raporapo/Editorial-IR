#!/usr/bin/env bash
# Synthetic footage for the probe cases: nine kinds of material, made by ffmpeg.
#
#   scripts/probe-footage.sh <output dir> [case1..case9]
#
# Each case lands in <output dir>/<case>/footage, ready for `oea ingest`:
#   case1 an edited programme (cuts, title cards, burned-in subtitles)
#   case2 phone clips trimmed on the phone      case3 sound files only
#   case4 photographs and one clip              case5 a drone clip with no sound
#   case6 a screen recording of slides          case7 variable frame rate
#   case8 a camera with two audio streams       case9 a camera left running
#
# Every input comes from lavfi sources with fixed seeds, encoded bit-exactly, so
# two runs make the same files. Needs ffmpeg with libx264, python3, and the
# DejaVu fonts (fonts-dejavu-core on Debian/Ubuntu) for the text in the picture.
# The sound is tones and noise, not speech: good for timing, structure and
# cost per event, not for judging what a transcript makes of it. The files are
# made, never committed.
set -euo pipefail
P="${1:?usage: probe-footage.sh <output dir> [case]}"
FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
MONO=/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf
FF="ffmpeg -hide_banner -loglevel error -y"
VENC="-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -g 60 -bf 0"
AENC="-c:a aac -b:a 128k -ar 48000"
BX="-fflags +bitexact -flags:v +bitexact -flags:a +bitexact -map_metadata -1"

only="${2:-all}"
want() { [[ "$only" == "all" || "$only" == "$1" ]]; }

# ---------------------------------------------------------------- case 1
if want case1; then
D=$P/case1-edited/footage; mkdir -p "$D"
# 20 segments, 57 s, + two 1.5 s black title cards = 60 s
durs=(3 2.5 3.5 2 4 3 2.5 3 2 3.5 2.5 3 4 2 3 2.5 3.5 2 3 2.5)
gens=("testsrc2=s=1280x720:r=30" "mandelbrot=s=1280x720:r=30" "smptehdbars=s=1280x720:r=30"
      "gradients=s=1280x720:r=30:speed=0.05:seed=3" "life=s=1280x720:r=30:seed=5:mold=10:ratio=0.2:death_color=#202040:life_color=#e0c040"
      "cellauto=s=1280x720:r=30:rule=110:seed=9" "testsrc=s=1280x720:r=30" "rgbtestsrc=s=1280x720:r=30"
      "zoneplate=s=1280x720:r=30:kt2=2:kx2=64:ky2=64" "colorspectrum=s=1280x720:r=30"
      "testsrc2=s=1280x720:r=30" "mandelbrot=s=1280x720:r=30:start_scale=1.5" "pal100bars=s=1280x720:r=30"
      "gradients=s=1280x720:r=30:speed=0.08:seed=11:c0=red:c1=blue" "life=s=1280x720:r=30:seed=17:mold=4"
      "cellauto=s=1280x720:r=30:rule=30:seed=23" "testsrc=s=1280x720:r=30" "yuvtestsrc=s=1280x720:r=30"
      "zoneplate=s=1280x720:r=30:kt2=5:kx2=16:ky2=128" "colorchart=r=30:patch_size=128x128")
inputs=(); fc=""; idx=0; t=0; cuts="0"
title() { # $1 text
  echo "color=c=black:s=1280x720:r=30:d=1.5,drawtext=fontfile=$FONT:text='$1':fontsize=80:fontcolor=white:x=(w-tw)/2:y=(h-th)/2,setsar=1,format=yuv420p,trim=duration=1.5,setpts=PTS-STARTPTS"
}
segs=()
segs+=("$(title 'HARBOUR DAYS')"); t=1.5; cuts="$cuts 1.5"
for i in $(seq 0 19); do
  if [[ $i == 10 ]]; then segs+=("$(title 'CHAPTER TWO')"); t=$(python3 -c "print($t+1.5)"); cuts="$cuts $t"; fi
  d=${durs[$i]}; h=$(( (i*47) % 360 ))
  segs+=("${gens[$i]},scale=1280:720,setsar=1,format=yuv420p,hue=h=$h:s=1.2,trim=duration=$d,setpts=PTS-STARTPTS")
  t=$(python3 -c "print($t+$d)"); cuts="$cuts $t"
done
n=${#segs[@]}
fc=""; lab=""
for k in $(seq 0 $((n-1))); do fc+="${segs[$k]}[v$k];"; lab+="[v$k]"; done
fc+="${lab}concat=n=$n:v=1:a=0[cat];"
# burned-in subtitles: 3 s on, 1 s off, starting at 2.0 -> across cuts
subs=("We got to the harbour just before dawn" "The fishing boats were already coming in" "Everyone was shouting prices at once"
      "We bought the smallest octopus we could find" "Then the rain started" "So we hid in a tiny noodle shop"
      "The owner has been here forty years" "He showed us how to fold dumplings" "Mine fell apart immediately"
      "After lunch the sky cleared" "We walked up to the lighthouse" "The view was worth every step"
      "Next time we will stay longer" "Thanks for watching")
chain="[cat]"; s=2
for k in "${!subs[@]}"; do
  e=$(python3 -c "print($s+3)")
  chain+="drawtext=fontfile=$FONT:text='${subs[$k]}':fontsize=40:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=12:x=(w-tw)/2:y=h-th-48:enable='between(t,$s,$e)',"
  s=$(python3 -c "print($s+4)")
done
chain="${chain%,}[vout]"
fc+="$chain"
$FF -filter_complex "$fc" \
  -f lavfi -i "sine=f=220:r=48000:d=60" -f lavfi -i "sine=f=277.18:r=48000:d=60" -f lavfi -i "sine=f=329.63:r=48000:d=60" \
  -f lavfi -i "anoisesrc=color=pink:amplitude=0.08:seed=7:r=48000:d=60" \
  -filter_complex "[0:a]volume=0.12[a0];[1:a]volume=0.10[a1];[2:a]volume=0.10[a2];[3:a]volume=1.0[a3];[a0][a1][a2][a3]amix=inputs=4:normalize=0,tremolo=f=2:d=0.3,aformat=channel_layouts=stereo[aout]" \
  -map "[vout]" -map "[aout]" $VENC $AENC -t 60 $BX "$D/harbour_days_final.mp4"
echo "$cuts" | tr ' ' '\n' > "$P/case1-edited/edit_points.txt"
fi

# ---------------------------------------------------------------- case 2
if want case2; then
D=$P/case2-pretrimmed/footage; mkdir -p "$D"
durs=(3 4 5 6 7 8 3.5 4.5)
names=(IMG_4101.mp4 IMG_4102.mp4 IMG_4103.mp4 IMG_4104.MOV IMG_4105.mp4 IMG_4106.mp4 IMG_4107.MOV IMG_4108.mp4)
gens=("testsrc2" "mandelbrot" "life=seed=3:mold=8" "gradients=speed=0.1:seed=5" "testsrc" "cellauto=rule=90:seed=4" "zoneplate=kt2=3:kx2=40:ky2=40" "mandelbrot=start_scale=2")
texts=("Look at this view" "The market is so busy today" "Here comes the train" "This is the best coffee I have had all week"
       "We finally made it to the top of the hill" "Listen to the waves" "Cheers" "Goodbye from the beach")
for i in $(seq 0 7); do
  d=${durs[$i]}; g=${gens[$i]}; sep=":"; [[ "$g" == *"="* ]] || sep="="
  if (( i % 3 == 2 )); then
    aud="sine=f=$((300+i*40)):r=48000:d=$d,volume=0.3"   # tone-only clip
  else
    aud="flite=text='${texts[$i]}':voice=slt,aresample=48000,apad,atrim=duration=$d,adelay=400:all=1,atrim=duration=$d"
  fi
  $FF -f lavfi -i "${g}${sep}s=1280x720:r=30" -f lavfi -i "$aud" \
    -filter_complex "[0:v]scale=1280:720,setsar=1,format=yuv420p,hue=h=$((i*40)),trim=duration=$d[v];[1:a]aformat=channel_layouts=stereo,apad,atrim=duration=$d[a]" \
    -map "[v]" -map "[a]" $VENC $AENC -t $d $BX "$D/${names[$i]}"
done
fi

# ---------------------------------------------------------------- case 3
if want case3; then
D=$P/case3-audioonly/footage; mkdir -p "$D"
# 40 s podcast-ish m4a: sentences with pauses
lines=("Welcome back to the show." "Today we are talking about how to edit a travel video." "The first rule is simple." "Show where you are before you show what happens there."
       "The second rule is to cut on the action." "And the third rule is to end somewhere that feels like an ending." "That is all for today. Thanks for listening.")
fc=""; lab=""; k=0
for l in "${lines[@]}"; do fc+="flite=text='$l':voice=rms,aresample=48000,apad=pad_dur=1.6[s$k];"; lab+="[s$k]"; k=$((k+1)); done
fc+="${lab}concat=n=$k:v=0:a=1,apad,atrim=duration=40,aformat=channel_layouts=mono[a]"
$FF -filter_complex "$fc" -map "[a]" -c:a aac -b:a 96k -ar 48000 $BX -t 40 "$D/podcast_ep12.m4a"
# wav: 1 s tone bursts, 2 s silence, 30 s
$FF -f lavfi -i "aevalsrc='0.4*sin(2*PI*440*t)*lt(mod(t,3),1)':s=48000:d=30" -c:a pcm_s16le $BX "$D/voice_memo_tones.wav"
# bonus mp3 voice memo, 12 s
$FF -f lavfi -i "flite=text='Note to self. Buy film for the camera and charge the drone batteries before Saturday.':voice=slt" -af "aresample=44100,apad,atrim=duration=12" -c:a libmp3lame -b:a 128k $BX "$D/memo.mp3"
fi

# ---------------------------------------------------------------- case 4
if want case4; then
D=$P/case4-stills/footage; mkdir -p "$D"
$FF -f lavfi -i "mandelbrot=s=4032x3024:start_scale=2" -frames:v 1 -q:v 3 $BX "$D/IMG_2001.jpg"
$FF -f lavfi -i "testsrc2=s=3024x4032" -vf "hue=h=120" -frames:v 1 -q:v 3 $BX "$D/IMG_2002.jpg"
$FF -f lavfi -i "smptehdbars=s=1920x1080" -vf "drawtext=fontfile=$FONT:text='Kyoto station':fontsize=90:fontcolor=white:x=80:y=80" -frames:v 1 -q:v 3 $BX "$D/IMG_2003.jpg"
$FF -f lavfi -i "gradients=s=1280x720:seed=4" -vf "drawtext=fontfile=$FONT:text='Day 2 map':fontsize=70:fontcolor=black:x=40:y=40" -frames:v 1 $BX "$D/map_day2.png"
$FF -f lavfi -i "testsrc2=s=1280x720:r=30" -f lavfi -i "flite=text='This is the only video from the day. The rest are photos.':voice=slt" \
  -filter_complex "[1:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=6[a]" -map 0:v -map "[a]" $VENC $AENC -t 6 $BX "$D/IMG_2004.mp4"
fi

# ---------------------------------------------------------------- case 5
if want case5; then
D=$P/case5-noaudio/footage; mkdir -p "$D"
$FF -f lavfi -i "mandelbrot=s=1280x720:r=30:start_scale=3" -vf "format=yuv420p" $VENC -an -t 30 $BX "$D/DJI_0042.mp4"
fi

# ---------------------------------------------------------------- case 6
if want case6; then
D=$P/case6-screen/footage; mkdir -p "$D"; T=$P/case6-screen/text; mkdir -p "$T"
slides=("$ npm install editorial-ir\nadded 214 packages in 6s\n\n$ oea init ./demo\ncreated project ./demo"
        "// src/index.ts\nimport { compile } from '@oea/core'\n\nconst ir = await compile(project)\nconsole.log(ir.events.length)"
        "Settings\n  Resolution      1920 x 1080\n  Frame rate      29.97\n  Audio           48 kHz stereo\n  Proxy           enabled"
        "$ oea analyze --project ./demo\nprobing 12 files\ntranscribing 12 files\nembedding 380 frames\ndone in 4m 12s"
        "Timeline\n  evt_0001  00:00:00  arrival at the station\n  evt_0002  00:00:14  ticket machine\n  evt_0003  00:00:41  platform"
        "Summary\n  - install\n  - analyze\n  - plan\n  - apply to Premiere\nThanks for watching")
vo=("First install the package and create a project." "Then import compile and run it on the project." "Check the settings before you start."
    "Now run analyze. It takes a few minutes." "Here is the timeline it produced." "That is the whole workflow.")
fc=""; chain="[bg]"
for k in 0 1 2 3 4 5; do
  printf "%b" "${slides[$k]}" > "$T/slide$k.txt"
  a=$((k*10)); b=$((k*10+10))
  chain+="drawtext=fontfile=$MONO:textfile=$T/slide$k.txt:fontsize=40:fontcolor=#202020:line_spacing=14:x=120:y=140:enable='gte(t,$a)*lt(t,$b)',"
done
chain="${chain%,}[txt]"
# cursor: moves during the first 2 s of every 10 s slide, still otherwise
cx="if(lt(mod(t,10),2), 300+mod(t,10)*400 + 60*floor(t/10), 1100+60*floor(t/10))"
cy="if(lt(mod(t,10),2), 700-mod(t,10)*150, 400)"
for k in 0 1 2 3 4 5; do
  $FF -f lavfi -i "flite=text='${vo[$k]}':voice=kal" -af "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono" -c:a pcm_s16le "$T/vo$k.wav"
done
afc=""; alab=""
for k in 0 1 2 3 4 5; do afc+="[$((k+2)):a]adelay=$((k*10000+2000)):all=1,apad,atrim=duration=60[v$k];"; alab+="[v$k]"; done
$FF -f lavfi -i "color=c=#f4f4f0:s=1920x1080:r=30:d=60" -f lavfi -i "color=c=#101010:s=18x28:r=30:d=60" \
  -i "$T/vo0.wav" -i "$T/vo1.wav" -i "$T/vo2.wav" -i "$T/vo3.wav" -i "$T/vo4.wav" -i "$T/vo5.wav" \
  -filter_complex "[0:v]format=yuv420p[bg];$chain;[txt][1:v]overlay=x='$cx':y='$cy':eval=frame,format=yuv420p[v];${afc}${alab}amix=inputs=6:normalize=0,aformat=channel_layouts=stereo[a]" \
  -map "[v]" -map "[a]" $VENC $AENC -t 60 $BX "$D/screen_2026-09-01_tutorial.mp4"
fi

# ---------------------------------------------------------------- case 7
if want case7; then
D=$P/case7-vfr/footage; mkdir -p "$D"
# 30 fps source, frames dropped to ~10 fps between 5-10 s and ~15 fps between 13-16 s; timestamps kept (VFR)
$FF -f lavfi -i "testsrc2=s=1280x720:r=30:d=20" -f lavfi -i "aevalsrc='0.5*sin(2*PI*1000*t)*lt(mod(t,1),0.1)':s=48000:d=20" \
  -vf "select='if(between(t,5,10),not(mod(n,3)),if(between(t,13,16),not(mod(n,2)),1))',format=yuv420p" \
  -fps_mode vfr $VENC -video_track_timescale 600 $AENC -t 20 $BX "$D/PXL_20260901_vfr.mp4"
fi

# ---------------------------------------------------------------- case 8
if want case8; then
D=$P/case8-twoaudio/footage; mkdir -p "$D"
spk=("Hi, I am testing the lavalier microphone." "This track should be much louder than the camera." "If you can hear me clearly, the second stream is the one to use."
     "The camera microphone is only picking up room tone." "Okay, that is the end of the test.")
fc=""; lab=""; k=0
for l in "${spk[@]}"; do fc+="flite=text='$l':voice=awb,aresample=48000,apad=pad_dur=2.0[s$k];"; lab+="[s$k]"; k=$((k+1)); done
fc+="${lab}concat=n=$k:v=0:a=1,volume=2.0,apad,atrim=duration=30,aformat=channel_layouts=mono[lav];"
fc+="[1:a]atrim=duration=30,aformat=channel_layouts=stereo[room]"
$FF -f lavfi -i "testsrc2=s=1280x720:r=30:d=30" -filter_complex "$fc" -f lavfi -i "anoisesrc=color=brown:amplitude=0.01:seed=3:r=48000:d=30" \
  -map 0:v -map "[room]" -map "[lav]" $VENC $AENC -metadata:s:a:0 title="Camera" -metadata:s:a:1 title="Lav" -t 30 -fflags +bitexact "$D/C0007.mp4"
fi

# ---------------------------------------------------------------- case 9
if want case9; then
D=$P/case9-dead/footage; mkdir -p "$D"
# A 0-30 active (motion + speech) | D 30-90 frozen frame + digital silence | A 90-120 active | D 120-180 black + digital silence
a1=("We are setting up the camera on the balcony." "The sun is going down behind the mountains." "Let me leave it running for a while.")
a2=("Okay I am back." "It is completely dark now but you can still see the city lights." "Let us go inside.")
fcA=""; l1=""; k=0; for l in "${a1[@]}"; do fcA+="flite=text='$l':voice=slt,aresample=48000,apad=pad_dur=1.5[p$k];"; l1+="[p$k]"; k=$((k+1)); done
fcB=""; l2=""; j=0; for l in "${a2[@]}"; do fcB+="flite=text='$l':voice=slt,aresample=48000,apad=pad_dur=1.5[q$j];"; l2+="[q$j]"; j=$((j+1)); done
$FF -f lavfi -i "testsrc2=s=1280x720:r=30:d=30" \
    -f lavfi -i "mandelbrot=s=1280x720:r=30:start_scale=2" \
    -f lavfi -i "mandelbrot=s=1280x720:r=30:start_scale=1.2" \
    -f lavfi -i "color=c=black:s=1280x720:r=30:d=60" \
  -filter_complex "\
[1:v]trim=start_frame=0:end_frame=1,loop=loop=1799:size=1:start=0,setpts=N/30/TB,trim=duration=60[frz];\
[2:v]trim=duration=30,setpts=PTS-STARTPTS[act2];\
[0:v]setpts=PTS-STARTPTS[act1];\
[3:v]setpts=PTS-STARTPTS[blk];\
[act1][frz][act2][blk]concat=n=4:v=1:a=0,format=yuv420p,setsar=1[v];\
${fcA}${l1}concat=n=$k:v=0:a=1,apad,atrim=duration=30[sa];\
${fcB}${l2}concat=n=$j:v=0:a=1,apad,atrim=duration=30[sb];\
anullsrc=r=48000:cl=mono,atrim=duration=60[z1];anullsrc=r=48000:cl=mono,atrim=duration=60[z2];\
[sa][z1][sb][z2]concat=n=4:v=0:a=1,aformat=channel_layouts=stereo[a]" \
  -map "[v]" -map "[a]" $VENC $AENC -t 180 $BX "$D/balcony_timelapse_attempt.mp4"
fi
echo done
