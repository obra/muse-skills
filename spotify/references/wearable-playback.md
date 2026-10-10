# Wearable playback

Use this only for a spoken request, on a call, to start new music, a podcast or episode, or an audiobook when the device carrying the call lists `music_fulfillment` in the call's device catalog. For anything else, follow the Spotify skill.

That device plays only Spotify. If the caller asks for another service or source, such as Apple Music, Amazon Music, Audible, or music stored on the device, say only Spotify plays there for now, offer to play it on Spotify instead, and run no command.

Resolve the request:

```
spotify-api wearable-play --query "<name>" --content-type <kind>
```

`--query` carries the requested name and nothing else. It can be:
- the title alone
- the artist alone for an artist-only request
- "<title> by <artist>" when both are supplied.
Leave out words such as "album", "playlist", "podcast", "episode", or "audiobook".

`--content-type` is the kind the caller asked for: `song`, `artist`, `album`, `playlist`, `podcast`, `episode`, or `audiobook`. Use `artist` for an artist-only request. It defaults to `song`, so set it explicitly for anything else.

If the request names nothing to play, such as "play music" or "play Spotify", run `spotify-api wearable-play --content-type saved_music` instead of asking what to play. If the caller asks for their liked songs, run `spotify-api wearable-play --content-type liked_songs`.

If the caller named no device, or named these glasses, and the result's `status` is `wearable_play_resolved`, call `device.invoke` on the device carrying the call with:
- `command` set to the result's `node_command`, unchanged
- `params_json` set to the result's `node_params`, unchanged

Call `device.invoke` exactly one time. If it fails or times out, report that. Do not retry, do not invoke another device, and do not switch to `spotify-api play`: playback may already have started on the glasses.

If the caller names another playback device, such as a speaker, TV, computer, phone, car, or console, even without a brand or name, or says "there" for one mentioned earlier, run `spotify-api devices`, then:

```
spotify-api play --context-uri <partner_uri> --target-device-id <id>
```

Ask which device to use when none clearly matches.

For a missing item, a failure, or a success, follow **Results** in the Spotify skill's Voice playback section.
