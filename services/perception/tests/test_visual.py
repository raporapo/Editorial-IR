"""Which candidates a row of image-text similarities actually supports.

The selection used to be ``score > 0.15``. Running a real model showed what
that constant does: with CLIP ViT-B/32 every similarity between six clearly
distinct frames and a nine-term vocabulary landed in [0.087, 0.274] with a mean
of 0.196, so the constant admitted 89% of all pairs and a sunlit field came back
labelled "a city at night with lights".

The numbers in these tests are that real matrix, kept verbatim, so the fix is
pinned to observed model output rather than to a story about it.
"""

from __future__ import annotations

from editorial_perception.backends.visual import labels_from_scores

VOCAB = [
    "a city at night with lights",
    "a plate of food on a table",
    "a presentation slide with text",
    "a sunny green field under a blue sky",
    "an orange sunset over the horizon",
    "the blue sea and ocean water",
    "two people",
    "a theme park gate",
    "a train",
]

# Measured, CLIP ViT-B/32, L2-normalised both sides.
DAYLIGHT = [0.168, 0.184, 0.210, 0.264, 0.185, 0.242, 0.219, 0.197, 0.223]
NIGHT_CITY = [0.274, 0.160, 0.203, 0.165, 0.219, 0.195, 0.205, 0.202, 0.223]
SLIDE = [0.105, 0.124, 0.230, 0.087, 0.112, 0.142, 0.156, 0.131, 0.173]
SUNSET = [0.181, 0.206, 0.206, 0.191, 0.273, 0.226, 0.219, 0.193, 0.221]


def test_the_right_label_wins_on_a_real_row():
    assert labels_from_scores(NIGHT_CITY, VOCAB)[0] == "a city at night with lights"
    assert labels_from_scores(SLIDE, VOCAB)[0] == "a presentation slide with text"
    assert labels_from_scores(SUNSET, VOCAB)[0] == "an orange sunset over the horizon"
    assert labels_from_scores(DAYLIGHT, VOCAB)[0] == "a sunny green field under a blue sky"


def test_a_sunlit_field_is_not_labelled_a_city_at_night():
    # The literal regression. Under `> 0.15` this frame came back with eight
    # labels including night, food and a theme park gate.
    labels = labels_from_scores(DAYLIGHT, VOCAB)
    assert "a city at night with lights" not in labels
    assert "a plate of food on a table" not in labels
    assert len(labels) <= 3


def test_labels_come_back_ordered_by_score():
    # The old cap was applied to a list built in vocabulary order, so it kept
    # the first eight that passed rather than the best eight. On the daylight
    # row that discarded the third-highest term and kept the lowest in the row.
    labels = labels_from_scores(DAYLIGHT, VOCAB, z=-10.0)
    ranked = [VOCAB[i] for i in sorted(range(len(VOCAB)), key=lambda i: -DAYLIGHT[i])]
    assert labels == ranked[: len(labels)]


def test_the_cap_keeps_the_best_rather_than_the_first():
    labels = labels_from_scores(DAYLIGHT, VOCAB, z=-10.0, max_labels=3)
    assert labels == [
        "a sunny green field under a blue sky",
        "the blue sea and ocean water",
        "a train",
    ]


def test_a_row_the_model_cannot_separate_produces_nothing():
    # A z-score alone always crowns a winner, and on a flat row that winner is
    # whichever way the noise fell. Saying nothing is the honest answer.
    assert labels_from_scores([0.2] * 9, VOCAB) == []


def test_a_nearly_flat_row_is_a_known_limit_rather_than_a_guarantee():
    # Deliberately not asserted as empty. A guard against "almost flat" has to
    # measure the spread against something, and every candidate for that
    # something (the mean, the largest value) reintroduces exactly the
    # dependence on where a model puts its scores that this function exists to
    # remove. An earlier version divided by the mean and consequently returned
    # different labels for a row shifted by a constant.
    #
    # What bounds the damage is the threshold: on rows with no real peak, about
    # one in six still yields a label. That is recorded, not hidden.
    almost = [0.2000, 0.2001, 0.2002, 0.1999, 0.2001, 0.2000, 0.1998, 0.2002, 0.2001]
    assert len(labels_from_scores(almost, VOCAB)) <= 1


def test_the_rule_does_not_depend_on_where_the_model_puts_its_scores():
    # The whole point. Shifting and scaling a row the way a different model
    # would must not change which candidates are chosen — that is what the old
    # constant could not survive.
    shifted = [value + 10.0 for value in NIGHT_CITY]
    scaled = [value * 37.0 for value in NIGHT_CITY]
    assert labels_from_scores(shifted, VOCAB) == labels_from_scores(NIGHT_CITY, VOCAB)
    assert labels_from_scores(scaled, VOCAB) == labels_from_scores(NIGHT_CITY, VOCAB)


def test_a_sigmoid_style_range_works_too():
    # SigLIP scores pairs independently rather than against each other, so its
    # numbers live somewhere else entirely. Unreachable from here to test for
    # real, so this at least pins that the rule is not tied to CLIP's range.
    sigmoid_ish = [0.01, 0.02, 0.01, 0.88, 0.03, 0.02, 0.05, 0.01, 0.02]
    assert labels_from_scores(sigmoid_ish, VOCAB) == ["a sunny green field under a blue sky"]


def test_an_empty_vocabulary_asks_nothing_and_answers_nothing():
    assert labels_from_scores(DAYLIGHT, []) == []
    assert labels_from_scores([], VOCAB) == []


def test_a_single_candidate_cannot_stand_out_from_itself():
    # With one option there is no distribution to compare against, and "the
    # best of one" is not evidence of anything.
    assert labels_from_scores([0.9], ["a train"]) == []


def test_a_mismatched_row_is_truncated_rather_than_indexed_past_the_end():
    # Defensive: a backend returning more scores than there were candidates
    # should not raise, and must never invent a label it has no word for.
    labels = labels_from_scores(DAYLIGHT, VOCAB[:4])
    assert set(labels) <= set(VOCAB[:4])


def test_the_cap_is_respected():
    assert len(labels_from_scores(DAYLIGHT, VOCAB, z=-10.0, max_labels=2)) == 2
