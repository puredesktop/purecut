export default () => <stage>
  <scene id="review-scene" active name="Caption review" width={1920} height={1080} fill="#101820" playhead={2}>
    <rect id="shirt" name="White shirt" width={1920} height={400} fill="#ffffff" end={8} />
    <captions id="review-caption" name="Offset captions" src="assets/review.srt" preset="whisper"
      x={-160} y={-20} fontSize={80} offsetX={-100} offsetY={0} start={1} end={8} />
  </scene>
</stage>;
