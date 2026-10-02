-- Which profile questions somebody has answered "no" to.
--
-- "I have no portfolio pictures" and "I don't keep fixed hours" are real
-- answers, and a roster that keeps listing them as missing teaches people the
-- roster is wrong. But the honest place for a "no" is not the field itself:
-- working hours are read by the reminder scheduler, and the word "none" where
-- it expects a time would quietly break quiet hours. So the answer lives here,
-- as a comma list of question keys, and the fields themselves stay empty.
ALTER TABLE staff ADD COLUMN profile_declined TEXT;
