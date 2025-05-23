import { gen, sampleOne } from 'testcheck'
import { text, relationship } from '@keystone-6/core/fields'
import { list } from '@keystone-6/core'
import { setupTestRunner } from '@keystone-6/api-tests/test-runner'
import { allowAll } from '@keystone-6/core/access'

const alphanumGenerator = gen.alphaNumString.notEmpty()

const runner = setupTestRunner({
  config: {
    lists: {
      Company: list({
        access: allowAll,
        fields: {
          name: text(),
          location: relationship({ ref: 'Location.company' }),
        },
      }),
      Location: list({
        access: allowAll,
        fields: {
          name: text(),
          // FIXME: We don't actully enforce isRequired.
          // @ts-expect-error
          company: relationship({ ref: 'Company.location', isRequired: true }),
        },
      }),
    },
  },
})

describe('update one to one relationship back reference', () => {
  test(
    'nested create',
    runner(async ({ context }) => {
      const locationName = sampleOne(alphanumGenerator)
      const _company = await context.query.Company.createOne({
        data: { location: { create: { name: locationName } } },
        query: 'id location { id }',
      })

      const companyId = _company.id
      const locationId = _company.location.id

      const company = (await context.query.Company.findOne({
        where: { id: companyId },
        query: 'id location { id }',
      })) as { id: any; location: { id: any } }
      // Everything should now be connected. 1-to-1 has a single connection on the first list defined.
      expect(company.location.id.toString()).toBe(locationId.toString())
    })
  )
})
