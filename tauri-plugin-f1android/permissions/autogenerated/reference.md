## Default Permission

Speech, keep-awake and the Wi-Fi multicast lock for the Android build.

None of these reach outside the app: no network, no storage, no user data. They
are split into separate commands only because they settle at different times —
`speak` resolves when the phrase finishes.

#### This default permission set includes the following:

- `allow-speak`
- `allow-stop`
- `allow-voices`
- `allow-is-ready`
- `allow-set-keep-awake`
- `allow-acquire-multicast-lock`
- `allow-release-multicast-lock`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`f1android:allow-acquire-multicast-lock`

</td>
<td>

Enables the acquire_multicast_lock command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`f1android:deny-acquire-multicast-lock`

</td>
<td>

Denies the acquire_multicast_lock command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`f1android:allow-is-ready`

</td>
<td>

Enables the is_ready command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`f1android:deny-is-ready`

</td>
<td>

Denies the is_ready command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`f1android:allow-release-multicast-lock`

</td>
<td>

Enables the release_multicast_lock command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`f1android:deny-release-multicast-lock`

</td>
<td>

Denies the release_multicast_lock command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`f1android:allow-set-keep-awake`

</td>
<td>

Enables the set_keep_awake command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`f1android:deny-set-keep-awake`

</td>
<td>

Denies the set_keep_awake command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`f1android:allow-speak`

</td>
<td>

Enables the speak command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`f1android:deny-speak`

</td>
<td>

Denies the speak command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`f1android:allow-stop`

</td>
<td>

Enables the stop command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`f1android:deny-stop`

</td>
<td>

Denies the stop command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`f1android:allow-voices`

</td>
<td>

Enables the voices command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`f1android:deny-voices`

</td>
<td>

Denies the voices command without any pre-configured scope.

</td>
</tr>
</table>
